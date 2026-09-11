import crypto from 'node:crypto';
import mongoose, { type FilterQuery } from 'mongoose';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/ApiError';
import { NotificationType, OrderStatus, UserRole, type Paginated } from '../../common/types';
import { paginate } from '../../common/utils/http';
import { emitToUser } from '../../sockets/emitter';
import { SocketEvent } from '../../sockets/events';
import { MasterProfile } from '../user/masterProfile.model';
import { Chat } from '../chat/chat.model';
import { notify } from '../notification/notification.service';
import { abortMatching, startMatching } from '../matching/matching.service';
import { CATEGORY_CRAFTS } from '../matching/matching.types';
import { Order, type IOrder, type OrderDocument } from './order.model';
import type { CancelOrderInput, CreateOrderInput, ListOrdersInput } from './order.validator';

/**
 * Short, unambiguous job code shown on the card (`#A1B2C3`). Drawn from an
 * alphabet with no `0/O` or `1/I`, so a client reading it out over the phone
 * cannot be misheard.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const generateCode = (): string => {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
};

const createWithUniqueCode = async (payload: Omit<Partial<IOrder>, 'code'>): Promise<OrderDocument> => {
  // A collision is vanishingly unlikely but not impossible; retry rather than
  // surfacing a duplicate-key error to the client.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await Order.create({ ...payload, code: generateCode() });
    } catch (error) {
      const isDuplicate =
        typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;
      if (!isDuplicate || attempt === 4) throw error;
    }
  }
  /* istanbul ignore next — unreachable: the loop either returns or throws. */
  throw new ConflictError('Could not allocate a job code');
};

export const createOrder = async (clientId: string, input: CreateOrderInput): Promise<OrderDocument> => {
  // One live job at a time keeps the client's home screen honest — it shows a
  // single "active job" card — and stops the matching queue being flooded.
  const live = await Order.exists({
    client: clientId,
    status: { $in: [OrderStatus.PENDING, OrderStatus.MATCHING] },
  });
  if (live) {
    throw new ConflictError('You already have a job waiting for a pro', 'ACTIVE_ORDER_EXISTS');
  }

  const order = await createWithUniqueCode({
    client: new mongoose.Types.ObjectId(clientId),
    title: input.title,
    description: input.description,
    category: input.category,
    address: input.address,
    region: input.region,
    location: input.location ? { type: 'Point', coordinates: input.location } : undefined,
    photos: input.photos,
    status: OrderStatus.PENDING,
  });

  const orderId = String(order._id);
  logger.info('Job posted', { orderId, clientId, category: order.category });

  // Matching runs alongside the response: the client gets their job back
  // immediately and watches the search progress over the socket.
  void startMatching(orderId).catch((error: unknown) => {
    logger.error('Matching failed to start', {
      orderId,
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return order;
};

const populated = (query: mongoose.Query<unknown, unknown>) =>
  query
    .populate('client', 'firstName lastName avatarUrl phone')
    .populate('master', 'firstName lastName avatarUrl phone');

export const listOrdersForUser = async (
  userId: string,
  role: UserRole,
  input: ListOrdersInput,
): Promise<Paginated<OrderDocument>> => {
  const filter: FilterQuery<IOrder> =
    role === UserRole.MASTER ? { master: userId } : { client: userId };

  if (input.status !== 'all') filter.status = input.status;

  const skip = (input.page - 1) * input.limit;

  const [items, total] = await Promise.all([
    populated(Order.find(filter)).sort({ createdAt: -1 }).skip(skip).limit(input.limit).exec() as Promise<
      OrderDocument[]
    >,
    Order.countDocuments(filter),
  ]);

  return paginate(items, total, input.page, input.limit);
};

export const getOrderForUser = async (orderId: string, userId: string): Promise<OrderDocument> => {
  const order = (await populated(Order.findById(orderId)).exec()) as OrderDocument | null;
  if (!order) throw new NotFoundError('Order');

  const clientId = (order.populated('client') ? order.client._id : order.client).toString();
  const masterId = order.master
    ? (order.populated('master') ? order.master._id : order.master).toString()
    : null;

  // A pro who was offered the job can read it even before accepting — that is
  // what the offer card renders from.
  const wasOffered = order.offers.some((offer) => offer.master.toString() === userId);

  if (clientId !== userId && masterId !== userId && !wasOffered) {
    throw new ForbiddenError('This job is not yours', 'ORDER_FORBIDDEN');
  }

  return order;
};

/**
 * The pro's live feed. It shows jobs in their trades that are still looking for
 * someone — the offer itself arrives over the socket, this is the browsable list
 * behind it.
 */
export const feedForMaster = async (
  masterId: string,
  page: number,
  limit: number,
): Promise<Paginated<OrderDocument>> => {
  const profile = await MasterProfile.findOne({ user: masterId }).lean();
  if (!profile) throw new NotFoundError('Master profile');

  const categories = (Object.keys(CATEGORY_CRAFTS) as (keyof typeof CATEGORY_CRAFTS)[]).filter(
    (category) => CATEGORY_CRAFTS[category].some((craft) => profile.crafts.includes(craft)),
  );

  const filter: FilterQuery<IOrder> = {
    status: { $in: [OrderStatus.PENDING, OrderStatus.MATCHING] },
    category: { $in: categories },
    client: { $ne: new mongoose.Types.ObjectId(masterId) },
    // Do not show a pro a job they already passed on or let time out.
    offers: {
      $not: {
        $elemMatch: {
          master: new mongoose.Types.ObjectId(masterId),
          outcome: { $in: ['passed', 'timeout'] },
        },
      },
    },
  };

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    // No phone number here: the pro has not paid for this job, and the client's
    // number is exactly what the fee buys. It appears once they accept.
    Order.find(filter)
      .populate('client', 'firstName lastName avatarUrl')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec(),
    Order.countDocuments(filter),
  ]);

  return paginate(items, total, page, limit);
};

/** Either side may cancel; the reason is mandatory and stays on the job. */
export const cancelOrder = async (
  orderId: string,
  userId: string,
  role: UserRole,
  input: CancelOrderInput,
): Promise<OrderDocument> => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Order');

  const isClient = order.client.toString() === userId;
  const isMaster = order.master?.toString() === userId;

  if (!isClient && !isMaster) {
    throw new ForbiddenError('This job is not yours', 'ORDER_FORBIDDEN');
  }
  if (order.status === OrderStatus.DONE) {
    throw new ConflictError('A completed job cannot be cancelled', 'ORDER_COMPLETED');
  }
  if (order.status === OrderStatus.CANCELLED) {
    throw new ConflictError('This job is already cancelled', 'ORDER_CANCELLED');
  }

  const wasSearching = order.status === OrderStatus.MATCHING || order.status === OrderStatus.PENDING;

  // Conditional on the status just read: a pro accepting in the same instant
  // moves the job on, and a plain save would then overwrite their paid
  // acceptance with a cancellation.
  const cancelled = await Order.findOneAndUpdate(
    { _id: order._id, status: order.status },
    {
      $set: {
        status: OrderStatus.CANCELLED,
        cancelReason: input.reason,
        cancelledBy: role,
        cancelledAt: new Date(),
      },
    },
    { new: true },
  );
  if (!cancelled) {
    throw new ConflictError('The job changed while you were cancelling it — reload and try again', 'ORDER_CHANGED');
  }

  if (wasSearching) await abortMatching(orderId);

  if (order.master) {
    // A pro who cancels an accepted job wears it on their profile.
    if (isMaster) {
      await MasterProfile.updateOne({ user: order.master }, { $inc: { cancelledJobs: 1 } });
    }
    await Chat.updateOne({ order: order._id }, { $set: { isClosed: true } });
  }

  const other = isClient ? order.master?.toString() : order.client.toString();
  if (other) {
    emitToUser(other, SocketEvent.ORDER_CANCELLED, {
      orderId,
      reason: cancelled.cancelReason,
      cancelledBy: role,
    });
    // The socket only reaches an open app; the notification also pushes.
    await notify({
      userId: other,
      type: NotificationType.ORDER_CANCELLED,
      orderId,
      data: { orderId },
    }).catch(() => undefined);
  }

  logger.info('Job cancelled', { orderId, by: role, userId });
  return cancelled;
};

/** The pro marks the work done; this is what opens the client's rating sheet. */
export const completeOrder = async (orderId: string, masterId: string): Promise<OrderDocument> => {
  const order = await Order.findOneAndUpdate(
    { _id: orderId, master: masterId, status: OrderStatus.ACCEPTED },
    { $set: { status: OrderStatus.DONE, completedAt: new Date() } },
    { new: true },
  );

  if (!order) {
    const exists = await Order.findById(orderId).lean();
    if (!exists) throw new NotFoundError('Order');
    if (exists.master?.toString() !== masterId) {
      throw new ForbiddenError('This job is not yours', 'ORDER_FORBIDDEN');
    }
    throw new ConflictError('Only an accepted job can be completed', 'ORDER_NOT_ACCEPTED');
  }

  await MasterProfile.updateOne({ user: masterId }, { $inc: { completedJobs: 1 } });
  await Chat.updateOne({ order: order._id }, { $set: { isClosed: false } });

  emitToUser(order.client.toString(), SocketEvent.ORDER_COMPLETED, {
    orderId,
    code: order.code,
    title: order.title,
    masterId,
  });
  // This is what asks the client to rate the pro, so it must arrive even when
  // the app is closed.
  await notify({
    userId: order.client.toString(),
    type: NotificationType.ORDER_COMPLETED,
    orderId,
    data: { orderId },
  }).catch(() => undefined);

  logger.info('Job completed', { orderId, masterId });
  return order;
};

/** Counts behind the filter pills on "My jobs". */
export const statusCountsForClient = async (
  clientId: string,
): Promise<Record<OrderStatus | 'all', number>> => {
  const rows = await Order.aggregate<{ _id: OrderStatus; count: number }>([
    { $match: { client: new mongoose.Types.ObjectId(clientId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  const counts = Object.values(OrderStatus).reduce(
    (accumulator, status) => ({ ...accumulator, [status]: 0 }),
    {} as Record<OrderStatus | 'all', number>,
  );
  counts.all = 0;

  rows.forEach((row) => {
    counts[row._id] = row.count;
    counts.all += row.count;
  });

  return counts;
};

export const orderFee = (): number => env.ORDER_ACCEPT_FEE;
