import mongoose, { type PipelineStage } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { keys, redis } from '../../config/redis';
import { supportsTransactions } from '../../config/database';
import { ConflictError, NotFoundError, PaymentRequiredError } from '../../common/errors/ApiError';
import {
  NotificationType,
  OrderStatus,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../../common/types';
import { notify } from '../notification/notification.service';
import { Order, type OrderDocument } from '../order/order.model';
import { MasterProfile } from '../user/masterProfile.model';
import { User } from '../user/user.model';
import { Chat } from '../chat/chat.model';
import { Transaction } from '../wallet/transaction.model';
import { emitToUser } from '../../sockets/emitter';
import { SocketEvent } from '../../sockets/events';
import { cancelOfferTimeout, offerTimeoutJobId, scheduleOfferTimeout } from '../../jobs/queues';
import { cancelLocal, isQueueCapable, scheduleLocal } from '../../jobs/scheduler';
import { CATEGORY_CRAFTS, type MatchCandidate, type MatchingRunState, type OutstandingOffer } from './matching.types';

const OFFER_TIMEOUT = env.MATCH_OFFER_TIMEOUT_SECONDS;

/**
 * Ranks the pros who could take this job.
 *
 * Filters: trade matches the job category, the pro is online and available, and
 * their balance covers the acceptance fee — the design tells pros a job is only
 * offered when they can actually pay for it. Sorted by rating descending, so the
 * best-rated pro sees it first.
 *
 * When the job carries coordinates the ranking runs as a `$geoNear` pipeline and
 * candidates outside `MATCH_RADIUS_KM` are dropped; without coordinates it falls
 * back to a region match.
 */
export const buildCandidates = async (order: OrderDocument): Promise<MatchCandidate[]> => {
  const crafts = CATEGORY_CRAFTS[order.category];
  const fee = env.ORDER_ACCEPT_FEE;

  const baseMatch: Record<string, unknown> = {
    crafts: { $in: crafts },
    isOnline: true,
    isAvailable: true,
  };

  const hasLocation = Array.isArray(order.location?.coordinates) && order.location.coordinates.length === 2;

  const pipeline: PipelineStage[] = hasLocation
    ? [
        {
          $geoNear: {
            near: { type: 'Point', coordinates: order.location!.coordinates },
            distanceField: 'distanceMeters',
            maxDistance: env.MATCH_RADIUS_KM * 1_000,
            query: baseMatch,
            spherical: true,
          },
        },
      ]
    : [{ $match: order.region ? { ...baseMatch, regions: order.region } : baseMatch }];

  pipeline.push(
    // Join the wallet in, so an under-funded pro never reaches the queue.
    {
      $lookup: {
        from: User.collection.name,
        localField: 'user',
        foreignField: '_id',
        as: 'account',
        pipeline: [
          { $match: { isActive: true, isBlocked: false, role: UserRole.MASTER } },
          { $project: { balance: 1 } },
        ],
      },
    },
    { $unwind: '$account' },
    { $match: { 'account.balance': { $gte: fee } } },
    // The client should never be offered their own job, in the case where one
    // person holds both roles.
    { $match: { user: { $ne: order.client } } },
    { $sort: { rating: -1, ratingCount: -1, completedJobs: -1 } },
    { $limit: env.MATCH_MAX_CANDIDATES },
    {
      $project: {
        _id: 0,
        masterId: { $toString: '$user' },
        rating: 1,
        ratingCount: 1,
        completedJobs: 1,
        distanceMeters: 1,
      },
    },
  );

  const rows = await MasterProfile.aggregate<{
    masterId: string;
    rating: number;
    ratingCount: number;
    completedJobs: number;
    distanceMeters?: number;
  }>(pipeline);

  return rows.map((row) => ({
    masterId: row.masterId,
    rating: row.rating,
    ratingCount: row.ratingCount,
    completedJobs: row.completedJobs,
    distanceKm:
      typeof row.distanceMeters === 'number' ? Math.round(row.distanceMeters / 100) / 10 : null,
  }));
};

const readOffer = async (orderId: string): Promise<OutstandingOffer | null> => {
  const raw = await redis.get(keys.matchOffer(orderId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OutstandingOffer;
  } catch {
    return null;
  }
};

/**
 * Arms the 45-second window. BullMQ is used where Redis supports it; otherwise
 * an in-process timer runs `expireOffer` instead, so the offer still moves on.
 * The decision lives here rather than in the queue module because that module
 * must not depend on this one.
 */
const armOfferTimeout = async (orderId: string, masterId: string): Promise<void> => {
  if (isQueueCapable()) {
    await scheduleOfferTimeout(orderId, masterId, OFFER_TIMEOUT);
    return;
  }
  // `expireOffer` is declared further down; the reference is inside a callback
  // that only runs once the module is fully initialised.
  scheduleLocal(offerTimeoutJobId(orderId, masterId), OFFER_TIMEOUT, () =>
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    expireOffer(orderId, masterId).then(() => undefined),
  );
};

const disarmOfferTimeout = async (orderId: string, masterId: string): Promise<void> => {
  if (isQueueCapable()) {
    await cancelOfferTimeout(orderId, masterId);
    return;
  }
  cancelLocal(offerTimeoutJobId(orderId, masterId));
};

const clearOffer = async (orderId: string, masterId: string): Promise<void> => {
  await Promise.all([
    redis.del(keys.matchOffer(orderId)),
    redis.del(keys.masterOffer(masterId)),
    disarmOfferTimeout(orderId, masterId),
  ]);
};

const publishSearchState = async (order: OrderDocument): Promise<void> => {
  const remaining = await redis.llen(keys.matchQueue(order.id as string));
  emitToUser(order.client.toString(), SocketEvent.ORDER_SEARCHING, {
    orderId: order.id as string,
    status: order.status,
    offered: order.offers.length,
    remaining,
  });
};

/** Offers the job to the next queued pro, or gives up when the queue runs dry. */
export const offerNext = async (orderId: string): Promise<MatchingRunState> => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Order');

  // A job that has moved on — accepted, cancelled, completed — stops the run.
  if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.MATCHING) {
    await redis.del(keys.matchQueue(orderId));
    return { orderId, offered: order.offers.length, remaining: 0, current: null };
  }

  const masterId = await redis.lpop(keys.matchQueue(orderId));

  if (!masterId) {
    order.status = OrderStatus.PENDING;
    await order.save();
    emitToUser(order.client.toString(), SocketEvent.ORDER_NO_MASTERS, {
      orderId,
      offered: order.offers.length,
    });
    logger.info('Matching exhausted its candidates', { orderId, offered: order.offers.length });
    return { orderId, offered: order.offers.length, remaining: 0, current: null };
  }

  const now = Date.now();
  const expiresAt = now + OFFER_TIMEOUT * 1_000;

  const offer: OutstandingOffer = { orderId, masterId, offeredAt: now, expiresAt };

  await Promise.all([
    // The Redis entry outlives the timeout slightly, so a worker that fires a
    // beat late still finds the offer it is meant to expire.
    redis.set(keys.matchOffer(orderId), JSON.stringify(offer), 'EX', OFFER_TIMEOUT + 10),
    redis.set(keys.masterOffer(masterId), orderId, 'EX', OFFER_TIMEOUT + 10),
  ]);

  order.status = OrderStatus.MATCHING;
  order.offers.push({ master: new mongoose.Types.ObjectId(masterId), offeredAt: new Date(now), outcome: 'pending' });
  await order.save();

  await armOfferTimeout(orderId, masterId);

  const client = await User.findById(order.client).select('firstName lastName').lean();

  emitToUser(masterId, SocketEvent.ORDER_OFFER, {
    orderId,
    code: order.code,
    title: order.title,
    description: order.description,
    category: order.category,
    client: {
      id: order.client.toString(),
      name: client ? `${client.firstName} ${client.lastName.charAt(0)}.` : '',
      initials: client ? `${client.firstName.charAt(0)}${client.lastName.charAt(0)}`.toUpperCase() : '',
    },
    distanceKm: null,
    region: order.region ?? null,
    fee: env.ORDER_ACCEPT_FEE,
    expiresInSeconds: OFFER_TIMEOUT,
    expiresAt: new Date(expiresAt).toISOString(),
  });

  await publishSearchState(order);

  // The push is what rings a locked phone — the socket event only reaches an
  // app that is already open.
  await notify({
    userId: masterId,
    type: NotificationType.ORDER_OFFER,
    orderId,
    body: order.title,
    data: { orderId, code: order.code, expiresAt: String(expiresAt) },
  }).catch((error: unknown) => {
    logger.warn('Could not notify the pro of an offer', {
      orderId,
      masterId,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info('Job offered', { orderId, masterId, timeout: OFFER_TIMEOUT });
  const remaining = await redis.llen(keys.matchQueue(orderId));
  return { orderId, offered: order.offers.length, remaining, current: masterId };
};

/** Entry point: builds the queue and makes the first offer. */
export const startMatching = async (orderId: string): Promise<MatchingRunState> => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Order');

  const candidates = await buildCandidates(order);
  const queueKey = keys.matchQueue(orderId);

  await redis.del(queueKey);

  if (candidates.length === 0) {
    emitToUser(order.client.toString(), SocketEvent.ORDER_NO_MASTERS, { orderId, offered: 0 });
    logger.info('No candidates for job', { orderId, category: order.category });
    return { orderId, offered: 0, remaining: 0, current: null };
  }

  await redis.rpush(queueKey, ...candidates.map((candidate) => candidate.masterId));
  // The queue is only meaningful while the search is running.
  await redis.expire(queueKey, OFFER_TIMEOUT * (candidates.length + 2));

  logger.info('Matching started', { orderId, candidates: candidates.length });
  return offerNext(orderId);
};

/** The pro declined. Their offer closes and the job moves down the list. */
export const passOffer = async (orderId: string, masterId: string): Promise<MatchingRunState> => {
  const offer = await readOffer(orderId);
  if (!offer || offer.masterId !== masterId) {
    throw new ConflictError('This job is no longer offered to you', 'OFFER_NOT_YOURS');
  }

  await Order.updateOne(
    { _id: orderId, 'offers.master': masterId, 'offers.outcome': 'pending' },
    { $set: { 'offers.$.outcome': 'passed', 'offers.$.respondedAt': new Date() } },
  );

  await clearOffer(orderId, masterId);
  return offerNext(orderId);
};

/** Called by the BullMQ worker when nobody answered in time. */
export const expireOffer = async (orderId: string, masterId: string): Promise<MatchingRunState | null> => {
  const offer = await readOffer(orderId);

  // The offer was already answered, or superseded — nothing to expire.
  if (!offer || offer.masterId !== masterId) return null;

  await Order.updateOne(
    { _id: orderId, 'offers.master': masterId, 'offers.outcome': 'pending' },
    { $set: { 'offers.$.outcome': 'timeout', 'offers.$.respondedAt': new Date() } },
  );

  await clearOffer(orderId, masterId);
  emitToUser(masterId, SocketEvent.ORDER_OFFER_REVOKED, { orderId, reason: 'timeout' });

  logger.info('Offer timed out', { orderId, masterId });
  return offerNext(orderId);
};

/**
 * The pro accepts, pays the fee and takes the job.
 *
 * Two guards stop a double-accept. First the order update is conditional on the
 * job still being unassigned, which is atomic in MongoDB whether or not a
 * transaction wraps it — so of two simultaneous accepts exactly one matches.
 * Second, the whole thing runs in a transaction where available, so the wallet
 * debit and the assignment commit or roll back together and a pro can never be
 * charged for a job they did not get.
 */
export const acceptOffer = async (
  orderId: string,
  masterId: string,
): Promise<{ order: OrderDocument; chatId: string; fee: number }> => {
  const offer = await readOffer(orderId);
  if (!offer || offer.masterId !== masterId) {
    throw new ConflictError('This job has already been taken', 'OFFER_TAKEN');
  }

  const fee = env.ORDER_ACCEPT_FEE;
  const useTransaction = supportsTransactions();
  const session = useTransaction ? await mongoose.startSession() : null;

  const run = async (): Promise<{ order: OrderDocument; chatId: string }> => {
    const options = session ? { session } : {};

    // Debit first, conditionally on sufficient funds — a single atomic update,
    // so two concurrent accepts cannot both pass a read-then-write balance check.
    const account = await User.findOneAndUpdate(
      { _id: masterId, balance: { $gte: fee }, isActive: true, isBlocked: false },
      { $inc: { balance: -fee } },
      { new: true, ...options },
    );

    if (!account) {
      throw new PaymentRequiredError(
        'Your balance does not cover the job fee',
        'INSUFFICIENT_BALANCE',
      );
    }

    const acceptedAt = new Date();

    const order = await Order.findOneAndUpdate(
      {
        _id: orderId,
        status: { $in: [OrderStatus.PENDING, OrderStatus.MATCHING] },
        master: { $exists: false },
      },
      {
        $set: {
          master: new mongoose.Types.ObjectId(masterId),
          status: OrderStatus.ACCEPTED,
          acceptedAt,
          acceptFee: fee,
        },
      },
      { new: true, ...options },
    );

    if (!order) {
      // Someone else won the race. Roll the debit back explicitly, because
      // without a transaction there is nothing else to undo it.
      if (!session) {
        await User.updateOne({ _id: masterId }, { $inc: { balance: fee } });
      }
      throw new ConflictError('This job has already been taken', 'OFFER_TAKEN');
    }

    await Order.updateOne(
      { _id: orderId, 'offers.master': masterId, 'offers.outcome': 'pending' },
      { $set: { 'offers.$.outcome': 'accepted', 'offers.$.respondedAt': acceptedAt } },
      options,
    );

    const [transaction] = await Transaction.create(
      [
        {
          user: new mongoose.Types.ObjectId(masterId),
          type: TransactionType.ORDER_FEE,
          status: TransactionStatus.SUCCESS,
          provider: PaymentProvider.BALANCE,
          amount: -fee,
          balanceAfter: account.balance,
          order: order._id,
          description: `Job acceptance fee — ${order.code}`,
          settledAt: acceptedAt,
        },
      ],
      options,
    );

    const [chat] = await Chat.create(
      [
        {
          participants: [order.client, new mongoose.Types.ObjectId(masterId)],
          order: order._id,
          unread: new Map<string, number>(),
        },
      ],
      options,
    );

    order.feeTransaction = transaction!._id;
    await order.save(options);

    return { order, chatId: (chat!._id).toString() };
  };

  let result: { order: OrderDocument; chatId: string };
  try {
    result = session ? await session.withTransaction(run) : await run();
  } finally {
    await session?.endSession();
  }

  // Everything below is post-commit: the job is already the pro's.
  await redis.del(keys.matchQueue(orderId));
  await clearOffer(orderId, masterId);

  const profile = await MasterProfile.findOne({ user: masterId }).lean();
  const account = await User.findById(masterId).select('firstName lastName').lean();

  emitToUser(result.order.client.toString(), SocketEvent.ORDER_ACCEPTED, {
    orderId,
    chatId: result.chatId,
    master: {
      id: masterId,
      name: account ? `${account.firstName} ${account.lastName}` : '',
      initials: account
        ? `${account.firstName.charAt(0)}${account.lastName.charAt(0)}`.toUpperCase()
        : '',
      rating: profile?.rating ?? 0,
      crafts: profile?.crafts ?? [],
    },
  });

  await notify({
    userId: result.order.client.toString(),
    type: NotificationType.ORDER_ACCEPTED,
    orderId,
    chatId: result.chatId,
    data: { orderId, chatId: result.chatId },
  }).catch(() => undefined);

  logger.info('Job accepted', { orderId, masterId, fee });
  return { order: result.order, chatId: result.chatId, fee };
};

/** Stops a run early — used when the client cancels while the search is live. */
export const abortMatching = async (orderId: string): Promise<void> => {
  const offer = await readOffer(orderId);
  await redis.del(keys.matchQueue(orderId));

  if (offer) {
    await clearOffer(orderId, offer.masterId);
    emitToUser(offer.masterId, SocketEvent.ORDER_OFFER_REVOKED, { orderId, reason: 'cancelled' });
  }
};

/** Lets a reconnecting pro pick their outstanding offer back up. */
export const outstandingOfferFor = async (masterId: string): Promise<OutstandingOffer | null> => {
  const orderId = await redis.get(keys.masterOffer(masterId));
  if (!orderId) return null;
  const offer = await readOffer(orderId);
  return offer?.masterId === masterId ? offer : null;
};
