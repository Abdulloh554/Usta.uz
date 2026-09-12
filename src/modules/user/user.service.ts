import type mongoose from 'mongoose';
import { keys, redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../common/errors/ApiError';
import type { Craft, Language} from '../../common/types';
import { OrderStatus, UserRole } from '../../common/types';
import { Order } from '../order/order.model';
import { Chat } from '../chat/chat.model';
import { Favorite, Product } from '../product/product.model';
import { Notification } from '../notification/notification.model';
import { disconnectUser } from '../../sockets/emitter';
import { logoutEverywhere, toPublicUser } from '../auth/auth.service';
import type { PublicUser } from '../auth/auth.types';
import { MasterProfile, type IMasterProfile } from './masterProfile.model';
import { User, type UserDocument } from './user.model';

export type UpdateProfileInput = {
  firstName?: string;
  lastName?: string;
  language?: Language;
  avatarUrl?: string;
};

export const updateProfile = async (userId: string, input: UpdateProfileInput): Promise<PublicUser> => {
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
 * Online state lives in Redis — the socket layer writes it on connect and
 * disconnect — and is mirrored onto the profile so the matching aggregate can
 * filter on it without a second round trip.
 */
export const setOnline = async (userId: string, online: boolean): Promise<void> => {
  const [profile] = await Promise.all([
    MasterProfile.findOneAndUpdate({ user: userId }, { $set: { isOnline: online } }),
    online
      ? redis.sadd(keys.onlineMasters, userId)
      : redis.srem(keys.onlineMasters, userId),
    User.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date() } }),
  ]);

  if (profile && online) {
    await redis.set(keys.onlineMaster(userId), '1', 'EX', 300);
  } else {
    await redis.del(keys.onlineMaster(userId));
  }
};

/** What anyone — signed in or not — may see about a pro: never their phone or wallet. */
type PublicMaster = Pick<
  PublicUser,
  'id' | 'firstName' | 'lastName' | 'fullName' | 'initials' | 'role' | 'avatarUrl' | 'createdAt'
>;

export type MasterPublicProfile = {
  user: PublicMaster;
  profile: IMasterProfile;
  stats: {
    rating: number;
    completedJobs: number;
    reviewCount: number;
  };
};

export const getMasterProfile = async (masterId: string): Promise<MasterPublicProfile> => {
  const user = await User.findById(masterId);
  if (!user || user.role !== UserRole.MASTER) throw new NotFoundError('Master');

  const profile = await MasterProfile.findOne({ user: masterId }).lean();
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
export const topMasters = async (limit = 5, craft?: Craft): Promise<
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
 * Deleting an account, as Google Play requires apps that create them to offer.
 *
 * The person's own details go: phone, name, avatar, push tokens, trade profile,
 * saved products and notifications. Their jobs, messages and reviews stay,
 * because they are also the other side's history — but with nothing left to
 * identify who they were. The phone number is released, so the same number can
 * sign up again as a new account.
 */
export const deleteAccount = async (userId: string, password: string): Promise<void> => {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new NotFoundError('User');

  if (!(await user.comparePassword(password))) {
    throw new UnauthorizedError('The password is incorrect', 'INVALID_CREDENTIALS');
  }

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

  await Promise.all([
    MasterProfile.deleteOne({ user: user._id }),
    Favorite.deleteMany({ user: user._id }),
    Notification.deleteMany({ user: user._id }),
    Product.updateMany({ seller: user._id }, { $set: { isActive: false, deletedAt: new Date() } }),
    Chat.updateMany({ participants: user._id }, { $set: { isClosed: true } }),
    redis.srem(keys.onlineMasters, userId),
  ]);

  // `updateOne` rather than `save`: the scrubbed phone deliberately breaks the
  // `+998…` format the schema enforces, so the number cannot be matched again.
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        phone: `deleted:${String(user._id)}`,
        firstName: 'Oʻchirilgan',
        lastName: 'foydalanuvchi',
        isActive: false,
        deletedAt: new Date(),
        pushTokens: [],
      },
      $unset: { avatarUrl: 1, blockReason: 1 },
    },
  );

  await logoutEverywhere(userId);
  disconnectUser(userId);

  logger.info('Account deleted by its owner', { userId });
};

export const findById = async (userId: string): Promise<UserDocument> => {
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User');
  return user;
};
