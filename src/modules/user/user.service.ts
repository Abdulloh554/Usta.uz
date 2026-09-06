import type mongoose from 'mongoose';
import { keys, redis } from '../../config/redis';
import { NotFoundError } from '../../common/errors/ApiError';
import type { Craft, Language} from '../../common/types';
import { OrderStatus, UserRole } from '../../common/types';
import { Order } from '../order/order.model';
import { toPublicUser } from '../auth/auth.service';
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

export type MasterPublicProfile = {
  user: PublicUser;
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

  return {
    user: toPublicUser(user),
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

export const findById = async (userId: string): Promise<UserDocument> => {
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User');
  return user;
};
