import mongoose from 'mongoose';
import { keys, redis } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../common/errors/ApiError';
import type { Craft, Language } from '../../common/types';
import { OrderStatus, TransactionStatus, UserRole } from '../../common/types';
import { Order } from '../order/order.model';
import { Chat, Message } from '../chat/chat.model';
import { Favorite, Product } from '../product/product.model';
import { Purchase } from '../product/purchase.model';
import { Notification } from '../notification/notification.model';
import { Review, ReviewTarget } from '../review/review.model';
import { recomputeRating } from '../review/review.service';
import { Transaction } from '../wallet/transaction.model';
import { AdminLog, AdminTarget } from '../admin/adminLog.model';
import { disconnectUser } from '../../sockets/emitter';
import { consumeOtp, logoutEverywhere, toPublicUser } from '../auth/auth.service';
import type { PublicUser } from '../auth/auth.types';
import { MasterProfile, type IMasterProfile } from './masterProfile.model';
import { User, type UserDocument } from './user.model';

export type UpdateProfileInput = {
  firstName?: string;
  lastName?: string;
  language?: Language;
  avatarUrl?: string;
};

export const updateProfile = async (
  userId: string,
  input: UpdateProfileInput,
): Promise<PublicUser> => {
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User');

  Object.assign(user, input);
  await user.save();
  return toPublicUser(user);
};

export type UpdateMasterProfileInput = {
  crafts?: Craft[];
  about?: string;
  regions?: string[];
  location?: [number, number];
  isAvailable?: boolean;
};

export const updateMasterProfile = async (
  userId: string,
  input: UpdateMasterProfileInput,
): Promise<IMasterProfile> => {
  const profile = await MasterProfile.findOne({ user: userId });
  if (!profile) throw new NotFoundError('Master profile');

  if (input.crafts) profile.crafts = input.crafts;
  if (input.about !== undefined) profile.about = input.about;
  if (input.regions) profile.regions = input.regions;
  if (input.isAvailable !== undefined) profile.isAvailable = input.isAvailable;
  if (input.location) profile.location = { type: 'Point', coordinates: input.location };

  await profile.save();
  return profile.toObject();
};

/**
 * Records that the user was here, at most once per throttle window.
 *
 * A phone on a mobile network drops and re-establishes its socket constantly,
 * and an unconditional write would mean a database write per reconnect per
 * user — the single heaviest write in the system at scale, for a field the
 * matching grace window only reads to minute resolution.
 *
 * Going offline always writes: that timestamp is precisely what decides how
 * much longer the pro keeps receiving offers by push.
 */
const touchLastSeen = async (userId: string, force: boolean): Promise<void> => {
  const throttle = env.PRESENCE_SEEN_THROTTLE_SECONDS;

  if (!force && throttle > 0) {
    try {
      if (await redis.get(keys.seenRecently(userId))) return;
      await redis.set(keys.seenRecently(userId), '1', 'EX', throttle);
    } catch {
      // Redis being unavailable must not stop the write; it only stops the
      // throttling, which is an optimisation rather than a correctness rule.
    }
  }

  await User.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date() } });
};

/**
 * Online state lives in Redis — the socket layer writes it on connect and
 * disconnect — and is mirrored onto the profile so the matching aggregate can
 * filter on it without a second round trip.
 */
export const setOnline = async (userId: string, online: boolean): Promise<void> => {
  const [profile] = await Promise.all([
    MasterProfile.updateOne({ user: userId }, { $set: { isOnline: online } }),
    online ? redis.sadd(keys.onlineMasters, userId) : redis.srem(keys.onlineMasters, userId),
    touchLastSeen(userId, !online),
  ]);

  if (profile.matchedCount > 0 && online) {
    await redis.set(keys.onlineMaster(userId), '1', 'EX', 300);
  } else {
    await redis.del(keys.onlineMaster(userId));
  }
};

/**
 * Counts a user's live sockets across every instance, and reports whether this
 * was their last one.
 *
 * The alternative — asking the Socket.IO adapter to enumerate a room — is a
 * request and response over Redis to every instance in the cluster, on every
 * single disconnect. A counter is one command.
 *
 * The count can drift upwards if an instance is killed without running its
 * disconnect handlers. That only delays a pro being marked offline, the key
 * expires on its own, and `isOnline` is corrected by their next connection —
 * so the cheap answer is the right trade here.
 */
export const trackSocket = async (
  userId: string,
  event: 'connect' | 'disconnect',
): Promise<{ remaining: number }> => {
  const key = keys.socketsOfUser(userId);

  try {
    if (event === 'connect') {
      const remaining = await redis.incr(key);
      // Outlives any real session, so a leaked counter cannot last forever.
      await redis.expire(key, 24 * 60 * 60);
      return { remaining };
    }

    const remaining = await redis.decr(key);
    if (remaining <= 0) await redis.del(key);
    return { remaining: Math.max(0, remaining) };
  } catch {
    // Without Redis the socket layer falls back to treating each disconnect as
    // the last one, which is the safe direction: a pro is marked offline and
    // their next event marks them back on.
    return { remaining: 0 };
  }
};

/** What anyone — signed in or not — may see about a pro: never their phone or wallet. */
type PublicMaster = Pick<
  PublicUser,
  'id' | 'firstName' | 'lastName' | 'fullName' | 'initials' | 'role' | 'avatarUrl' | 'createdAt'
>;

/**
 * The pro's profile fields that are safe to publish. Location, presence
 * (`isOnline`, `lastOfferAt`) and the cancellation count stay private: the
 * first two let anyone track a pro's movements and working hours.
 */
const PUBLIC_PROFILE_FIELDS = [
  'crafts',
  'about',
  'regions',
  'rating',
  'ratingCount',
  'completedJobs',
  'createdAt',
] as const satisfies readonly (keyof IMasterProfile)[];

type PublicMasterProfileFields = Pick<IMasterProfile, (typeof PUBLIC_PROFILE_FIELDS)[number]>;

export type MasterPublicProfile = {
  user: PublicMaster;
  profile: PublicMasterProfileFields;
  stats: {
    rating: number;
    completedJobs: number;
    reviewCount: number;
  };
};

export const getMasterProfile = async (masterId: string): Promise<MasterPublicProfile> => {
  const user = await User.findById(masterId);
  if (!user || user.role !== UserRole.MASTER) throw new NotFoundError('Master');

  // Projected at the query, so a field added to the model later stays private
  // until someone deliberately publishes it.
  const profile = await MasterProfile.findOne({ user: masterId })
    .select([...PUBLIC_PROFILE_FIELDS, '-_id'].join(' '))
    .lean<PublicMasterProfileFields>();
  if (!profile) throw new NotFoundError('Master profile');

  const account = toPublicUser(user);
  return {
    user: {
      id: account.id,
      firstName: account.firstName,
      lastName: account.lastName,
      fullName: account.fullName,
      initials: account.initials,
      role: account.role,
      avatarUrl: account.avatarUrl,
      createdAt: account.createdAt,
    },
    profile,
    stats: {
      rating: profile.rating,
      completedJobs: profile.completedJobs,
      reviewCount: profile.ratingCount,
    },
  };
};

/** The "top-rated pros" list on the client's home screen. */
export const topMasters = async (
  limit = 5,
  craft?: Craft,
): Promise<
  Array<{
    id: string;
    name: string;
    initials: string;
    crafts: Craft[];
    rating: number;
    completedJobs: number;
  }>
> => {
  const match: Record<string, unknown> = { ratingCount: { $gt: 0 } };
  if (craft) match.crafts = craft;

  const rows = await MasterProfile.aggregate<{
    user: mongoose.Types.ObjectId;
    crafts: Craft[];
    rating: number;
    completedJobs: number;
    account: { firstName: string; lastName: string };
  }>([
    { $match: match },
    { $sort: { rating: -1, completedJobs: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: User.collection.name,
        localField: 'user',
        foreignField: '_id',
        as: 'account',
        pipeline: [
          { $match: { isActive: true, isBlocked: false } },
          { $project: { firstName: 1, lastName: 1 } },
        ],
      },
    },
    { $unwind: '$account' },
  ]);

  return rows.map((row) => ({
    id: row.user.toString(),
    name: `${row.account.firstName} ${row.account.lastName}`,
    initials: `${row.account.firstName.charAt(0)}${row.account.lastName.charAt(0)}`.toUpperCase(),
    crafts: row.crafts,
    rating: row.rating,
    completedJobs: row.completedJobs,
  }));
};

/** Work history shown on the pro's own profile screen. */
export const workHistory = async (masterId: string, limit = 20) =>
  Order.find({ master: masterId, status: OrderStatus.DONE })
    .sort({ completedAt: -1 })
    .limit(limit)
    .select('code title completedAt acceptFee category')
    .lean();

/**
 * Removes an account and everything that is about it, for good:
 *
 * - the user, their trade profile, favourites, notifications, products (with
 *   the favourites, reviews and purchases of them) and pending top-up requests;
 * - the jobs they posted, every chat they were in with its messages, and every
 *   review they wrote or received — the ratings those reviews counted towards
 *   are worked out again;
 * - the journal's entries about them.
 *
 * Jobs they took for someone else stay with that client, with no pro on them.
 * Settled payments stay in the ledger without a name, so the platform's own
 * takings do not change; the wallet balance goes with the account. The user is
 * removed last, so a failure half-way leaves an account that can be deleted
 * again rather than records pointing at nobody.
 */
export const removeAccount = async (accountId: mongoose.Types.ObjectId | string): Promise<void> => {
  const id = new mongoose.Types.ObjectId(String(accountId));
  const [ownOrders, ownProducts, chats, written] = await Promise.all([
    Order.find({ client: id }).select('_id').lean(),
    Product.find({ seller: id }).select('_id').lean(),
    Chat.find({ participants: id }).select('_id').lean(),
    Review.find({ author: id }).select('targetType target').lean(),
  ]);
  const orderIds = ownOrders.map((order) => order._id);
  const productIds = ownProducts.map((product) => product._id);
  const chatIds = chats.map((chat) => chat._id);

  await Promise.all([
    Message.deleteMany({ chat: { $in: chatIds } }),
    Review.deleteMany({
      $or: [
        { author: id },
        { order: { $in: orderIds } },
        { targetType: ReviewTarget.MASTER, target: id },
        { targetType: ReviewTarget.PRODUCT, target: { $in: productIds } },
      ],
    }),
    Favorite.deleteMany({ $or: [{ user: id }, { product: { $in: productIds } }] }),
    Purchase.deleteMany({ $or: [{ buyer: id }, { seller: id }] }),
    // Theirs, and the ones others got about their jobs and chats.
    Notification.deleteMany({
      $or: [{ user: id }, { order: { $in: orderIds } }, { chat: { $in: chatIds } }],
    }),
    MasterProfile.deleteOne({ user: id }),
    Transaction.deleteMany({ user: id, status: TransactionStatus.PENDING }),
    AdminLog.deleteMany({ targetType: AdminTarget.USER, targetId: id }),
  ]);

  await Promise.all([
    Chat.deleteMany({ _id: { $in: chatIds } }),
    Order.deleteMany({ _id: { $in: orderIds } }),
    Product.deleteMany({ _id: { $in: productIds } }),
    Order.updateMany({ 'offers.master': id }, { $pull: { offers: { master: id } } }),
    Transaction.updateMany({ user: id }, { $unset: { user: 1 } }),
  ]);
  // A job they finished for someone has no one left to rate; the done ones
  // first, as the second update takes the pro off every remaining job.
  await Order.updateMany(
    { master: id, status: OrderStatus.DONE },
    { $unset: { master: 1 }, $set: { isRated: true } },
  );
  await Order.updateMany({ master: id }, { $unset: { master: 1 } });

  await User.deleteOne({ _id: id });

  // The ratings the removed reviews counted towards — not this account's own,
  // nor its products', which are gone with it.
  const gone = new Set([String(id), ...productIds.map(String)]);
  const recount = new Map<string, { targetType: ReviewTarget; target: mongoose.Types.ObjectId }>();
  written.forEach((review) => {
    if (!gone.has(String(review.target))) recount.set(`${review.targetType}:${String(review.target)}`, review);
  });
  await Promise.all([...recount.values()].map((review) => recomputeRating(review.targetType, review.target)));

  await redis.srem(keys.onlineMasters, String(id));
  await logoutEverywhere(String(id));
  disconnectUser(String(id));
};

/**
 * The removal, once whoever asked has been checked: the owner (below, with
 * their password or a mailed code) or an admin from the panel. A live job stops
 * it either way — the other side would be left waiting on nobody.
 */
export const eraseAccount = async (user: UserDocument): Promise<void> => {
  const live = await Order.exists({
    $or: [{ client: user._id }, { master: user._id }],
    status: { $in: [OrderStatus.PENDING, OrderStatus.MATCHING, OrderStatus.ACCEPTED] },
  });
  if (live) {
    throw new ConflictError(
      'Finish or cancel your active job before deleting your account',
      'ACTIVE_ORDER_EXISTS',
    );
  }
  await removeAccount(user._id);
};

/**
 * Deletion used to scrub an account and keep it (`deletedAt` set, the phone
 * replaced). This removes those leftovers the way deletion now works, wallet
 * balance included. Run at start-up; once none are left it finds nothing.
 */
export const purgeScrubbedAccounts = async (): Promise<number> => {
  const leftovers = await User.find({ deletedAt: { $ne: null } }).select('_id').lean();
  // One at a time: each removal touches a dozen collections.
  await leftovers.reduce<Promise<void>>(
    (previous, account) => previous.then(() => removeAccount(account._id)),
    Promise.resolve(),
  );
  return leftovers.length;
};

/**
 * Deleting an account, as Google Play requires apps that create them to offer.
 * Everything about the person goes (see `removeAccount`), and the phone number
 * is free again, so the same number can sign up as a new account.
 */
export const deleteAccount = async (
  userId: string,
  proof: { password?: string; code?: string },
): Promise<void> => {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new NotFoundError('User');

  if (proof.code) {
    // Code-only accounts have no password: the mailed code is the re-check.
    if (!user.email)
      throw new UnauthorizedError('The code is wrong or has expired', 'INVALID_CODE');
    await consumeOtp('delete', user.email, proof.code);
  } else if (!proof.password || !(await user.comparePassword(proof.password))) {
    throw new UnauthorizedError('The password is incorrect', 'INVALID_CREDENTIALS');
  }

  await eraseAccount(user);
  logger.info('Account deleted by its owner', { userId });
};

export const findById = async (userId: string): Promise<UserDocument> => {
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User');
  return user;
};
