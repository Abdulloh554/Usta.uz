import mongoose, { type FilterQuery, type SortOrder } from 'mongoose';
import { logger } from '../../config/logger';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentRequiredError,
} from '../../common/errors/ApiError';
import {
  NotificationType,
  OrderStatus,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
  type Paginated,
} from '../../common/types';
import { paginate } from '../../common/utils/http';
import { emitToUser } from '../../sockets/emitter';
import { SocketEvent } from '../../sockets/events';
import { User, type IUser, type UserDocument } from '../user/user.model';
import { MasterProfile } from '../user/masterProfile.model';
import { Order, type IOrder, type OrderDocument } from '../order/order.model';
import { Chat, Message, type ChatDocument, type IChat, type IMessage } from '../chat/chat.model';
import { Product, type IProduct, type ProductDocument } from '../product/product.model';
import { Review, ReviewTarget, type IReview, type ReviewDocument } from '../review/review.model';
import { Transaction, type ITransaction, type TransactionDocument } from '../wallet/transaction.model';
import { refundOrderFee } from '../wallet/wallet.service';
import { recomputeRating } from '../review/review.service';
import { notify } from '../notification/notification.service';
import { abortMatching } from '../matching/matching.service';
import { logoutEverywhere } from '../auth/auth.service';
import {
  AdminAction,
  AdminLog,
  AdminTarget,
  type AdminLogDocument,
} from './adminLog.model';
import type {
  AdjustBalanceInput,
  AdminCancelOrderInput,
  BroadcastInput,
  ListChatsInput,
  ListLogsInput,
  ListOrdersInput,
  ListProductsInput,
  ListReviewsInput,
  ListTransactionsInput,
  ListUsersInput,
  UpdateUserStatusInput,
} from './admin.validator';

const oid = (id: string): mongoose.Types.ObjectId => new mongoose.Types.ObjectId(id);

/** Search text goes into a regex; escaping it stops `.*` from matching every row. */
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const contains = (value: string): RegExp => new RegExp(escapeRegex(value), 'i');

const isObjectId = (value: string): boolean => /^[0-9a-fA-F]{24}$/.test(value);

const PERSON = 'firstName lastName phone avatarUrl role';

const record = async (
  adminId: string,
  action: AdminAction,
  targetType: AdminTarget,
  targetId: string | null,
  summary: string,
  meta: Record<string, unknown> = {},
): Promise<void> => {
  // The journal must never be the reason an admin action fails — the action has
  // already happened by the time it is written.
  try {
    await AdminLog.create({
      admin: oid(adminId),
      action,
      targetType,
      targetId: targetId ? oid(targetId) : undefined,
      summary,
      meta,
    });
  } catch (error) {
    logger.error('Could not write the admin log', {
      action,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  logger.info('Admin action', { adminId, action, targetId, summary });
};

/* ────────────────────────────── users ────────────────────────────── */

const USER_SORT: Record<ListUsersInput['sort'], Record<string, SortOrder>> = {
  new: { createdAt: -1 },
  old: { createdAt: 1 },
  balance: { balance: -1, createdAt: -1 },
  seen: { lastSeenAt: -1, createdAt: -1 },
};

export const listUsers = async (input: ListUsersInput): Promise<Paginated<UserDocument>> => {
  const filter: FilterQuery<IUser> = {};
  if (input.role) filter.role = input.role;
  if (input.status === 'active') Object.assign(filter, { isBlocked: false, isActive: true });
  if (input.status === 'blocked') filter.isBlocked = true;
  if (input.status === 'inactive') filter.isActive = false;

  if (input.search) {
    const digits = input.search.replace(/\D/g, '');
    const or: FilterQuery<IUser>[] = [
      { firstName: contains(input.search) },
      { lastName: contains(input.search) },
    ];
    // "Dilnoza Rahimova" typed as one string should still find her.
    const [first, last] = input.search.split(/\s+/);
    if (first && last) or.push({ firstName: contains(first), lastName: contains(last) });
    if (digits.length >= 3) or.push({ phone: new RegExp(digits) });
    if (isObjectId(input.search)) or.push({ _id: oid(input.search) });
    filter.$or = or;
  }

  const skip = (input.page - 1) * input.limit;
  const [items, total] = await Promise.all([
    User.find(filter).select('-pushTokens').sort(USER_SORT[input.sort]).skip(skip).limit(input.limit).exec(),
    User.countDocuments(filter),
  ]);

  return paginate(items, total, input.page, input.limit);
};

export const getUser = async (userId: string) => {
  const user = await User.findById(userId).select('-pushTokens');
  if (!user) throw new NotFoundError('User');

  const id = user._id;
  const [
    masterProfile,
    ordersAsClient,
    ordersAsMaster,
    products,
    reviewsWritten,
    reviewsReceived,
    chats,
    messages,
    spent,
    toppedUp,
    recentOrders,
    recentTransactions,
    recentProducts,
    log,
  ] = await Promise.all([
    user.role === UserRole.MASTER ? MasterProfile.findOne({ user: id }).exec() : null,
    Order.countDocuments({ client: id }),
    Order.countDocuments({ master: id }),
    Product.countDocuments({ seller: id }),
    Review.countDocuments({ author: id }),
    Review.countDocuments({ target: id, targetType: ReviewTarget.MASTER }),
    Chat.countDocuments({ participants: id }),
    Message.countDocuments({ sender: id }),
    Transaction.aggregate<{ total: number }>([
      { $match: { user: id, type: TransactionType.ORDER_FEE, status: TransactionStatus.SUCCESS } },
      { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
    ]),
    Transaction.aggregate<{ total: number }>([
      { $match: { user: id, type: TransactionType.TOP_UP, status: TransactionStatus.SUCCESS } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Order.find({ $or: [{ client: id }, { master: id }] })
      .sort({ createdAt: -1 })
      .limit(15)
      .select('code title category status client master createdAt acceptFee region')
      .exec(),
    Transaction.find({ user: id }).sort({ createdAt: -1 }).limit(15).exec(),
    Product.find({ seller: id }).sort({ createdAt: -1 }).limit(15).exec(),
    AdminLog.find({ targetType: AdminTarget.USER, targetId: id })
      .sort({ createdAt: -1 })
      .limit(15)
      .populate('admin', 'firstName lastName')
      .exec(),
  ]);

  return {
    user,
    masterProfile,
    counts: {
      ordersAsClient,
      ordersAsMaster,
      products,
      reviewsWritten,
      reviewsReceived,
      chats,
      messages,
      feesPaid: spent[0]?.total ?? 0,
      toppedUp: toppedUp[0]?.total ?? 0,
    },
    recentOrders,
    recentTransactions,
    recentProducts,
    log,
  };
};

const loadManageableUser = async (adminId: string, userId: string): Promise<UserDocument> => {
  if (adminId === userId) {
    throw new ForbiddenError('You cannot change your own account from here', 'ADMIN_SELF');
  }
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User');
  if (user.role === UserRole.ADMIN) {
    throw new ForbiddenError('Another admin cannot be managed from the panel', 'ADMIN_PROTECTED');
  }
  return user;
};

export const updateUserStatus = async (
  adminId: string,
  userId: string,
  input: UpdateUserStatusInput,
): Promise<UserDocument> => {
  const user = await loadManageableUser(adminId, userId);
  const actions: Array<[AdminAction, string]> = [];

  if (input.isBlocked !== undefined && input.isBlocked !== user.isBlocked) {
    if (input.isBlocked && !input.blockReason) {
      throw new BadRequestError('A reason is required to block an account', [
        { field: 'blockReason', message: 'required' },
      ]);
    }
    user.isBlocked = input.isBlocked;
    user.blockReason = input.isBlocked ? input.blockReason : undefined;
    actions.push(
      input.isBlocked
        ? [AdminAction.USER_BLOCKED, `Blocked ${user.fullName()}: ${input.blockReason ?? ''}`]
        : [AdminAction.USER_UNBLOCKED, `Unblocked ${user.fullName()}`],
    );
  }

  if (input.isActive !== undefined && input.isActive !== user.isActive) {
    user.isActive = input.isActive;
    actions.push(
      input.isActive
        ? [AdminAction.USER_ACTIVATED, `Activated ${user.fullName()}`]
        : [AdminAction.USER_DEACTIVATED, `Deactivated ${user.fullName()}`],
    );
  }

  if (actions.length === 0) return user;
  await user.save();

  // A blocked or deactivated account loses every session at once, and a pro
  // stops being offered jobs straight away rather than at their next reconnect.
  if (user.isBlocked || !user.isActive) {
    await logoutEverywhere(userId);
    if (user.role === UserRole.MASTER) {
      await MasterProfile.updateOne({ user: user._id }, { $set: { isOnline: false } });
    }
  }

  await Promise.all(
    actions.map(([action, summary]) =>
      record(adminId, action, AdminTarget.USER, userId, summary, { reason: input.blockReason }),
    ),
  );
  return user;
};

export const revokeSessions = async (adminId: string, userId: string): Promise<void> => {
  const user = await loadManageableUser(adminId, userId);
  await logoutEverywhere(userId);
  await record(
    adminId,
    AdminAction.USER_SESSIONS_REVOKED,
    AdminTarget.USER,
    userId,
    `Signed ${user.fullName()} out of every device`,
  );
};

/**
 * A manual correction to a wallet. The update is conditional, so a debit can
 * never take a balance below zero even if the user spends in the same instant.
 */
export const adjustBalance = async (
  adminId: string,
  userId: string,
  input: AdjustBalanceInput,
): Promise<{ user: UserDocument; transaction: TransactionDocument }> => {
  const existing = await User.findById(userId).select('_id firstName lastName balance');
  if (!existing) throw new NotFoundError('User');

  const guard = input.amount < 0 ? { balance: { $gte: -input.amount } } : {};
  const user = await User.findOneAndUpdate(
    { _id: existing._id, ...guard },
    { $inc: { balance: input.amount } },
    { new: true },
  ).select('-pushTokens');

  if (!user) {
    throw new PaymentRequiredError(
      `The balance is ${existing.balance} so'm — it cannot be debited by ${Math.abs(input.amount)}`,
      'BALANCE_TOO_LOW',
    );
  }

  const transaction = await Transaction.create({
    user: user._id,
    type: TransactionType.ADJUSTMENT,
    status: TransactionStatus.SUCCESS,
    provider: PaymentProvider.BALANCE,
    amount: input.amount,
    balanceAfter: user.balance,
    description: input.note,
    meta: { adminId },
    settledAt: new Date(),
  });

  if (input.amount > 0) {
    await notify({
      userId,
      type: NotificationType.WALLET_TOPPED_UP,
      data: { amount: String(input.amount), balance: String(user.balance) },
    }).catch(() => undefined);
  }

  await record(
    adminId,
    AdminAction.USER_BALANCE_ADJUSTED,
    AdminTarget.USER,
    userId,
    `${input.amount > 0 ? '+' : ''}${input.amount} so'm to ${user.fullName()}: ${input.note}`,
    { amount: input.amount, balanceAfter: user.balance, transactionId: String(transaction._id) },
  );

  return { user, transaction };
};

/* ────────────────────────────── orders ───────────────────────────── */

export const listOrders = async (input: ListOrdersInput): Promise<Paginated<OrderDocument>> => {
  const filter: FilterQuery<IOrder> = {};
  if (input.status) filter.status = input.status;
  if (input.category) filter.category = input.category;
  if (input.user) filter.$or = [{ client: oid(input.user) }, { master: oid(input.user) }];

  if (input.search) {
    const code = input.search.replace(/^#/, '').toUpperCase();
    const textMatch: FilterQuery<IOrder>[] = [
      { code: new RegExp(`^${escapeRegex(code)}`) },
      { title: contains(input.search) },
      { region: contains(input.search) },
    ];
    if (isObjectId(input.search)) textMatch.push({ _id: oid(input.search) });
    // Combine with the user filter rather than overwriting its `$or`.
    filter.$and = [{ $or: textMatch }];
  }

  const skip = (input.page - 1) * input.limit;
  const [items, total] = await Promise.all([
    Order.find(filter)
      .select('-offers')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .populate('client', PERSON)
      .populate('master', PERSON)
      .exec(),
    Order.countDocuments(filter),
  ]);

  return paginate(items, total, input.page, input.limit);
};

export const getOrder = async (orderId: string) => {
  const order = await Order.findById(orderId)
    .populate('client', PERSON)
    .populate('master', PERSON)
    .populate('offers.master', 'firstName lastName phone')
    .populate('feeTransaction');
  if (!order) throw new NotFoundError('Order');

  const [chat, review, refund, log] = await Promise.all([
    Chat.findOne({ order: order._id }).select('_id isClosed lastMessageAt').exec(),
    Review.findOne({ order: order._id }).populate('author', 'firstName lastName').exec(),
    Transaction.findOne({
      order: order._id,
      type: TransactionType.REFUND,
      status: TransactionStatus.SUCCESS,
    }).exec(),
    AdminLog.find({ targetType: AdminTarget.ORDER, targetId: order._id })
      .sort({ createdAt: -1 })
      .populate('admin', 'firstName lastName')
      .exec(),
  ]);

  const messageCount = chat ? await Message.countDocuments({ chat: chat._id }) : 0;
  return { order, chat, messageCount, review, refund, log };
};

/**
 * Support cancels a job on someone's behalf — a dispute, a fake post, a pro who
 * never turned up. It mirrors the user-side cancel, notifies both sides, and can
 * hand the pro their acceptance fee back in the same step.
 */
export const cancelOrder = async (
  adminId: string,
  orderId: string,
  input: AdminCancelOrderInput,
): Promise<{ order: OrderDocument; refunded: number }> => {
  const order = await Order.findById(orderId);
  if (!order) throw new NotFoundError('Order');
  // A finished job — done, or already cancelled by one side — can still have its
  // fee refunded, which is how support settles a dispute after the fact.
  if (order.status === OrderStatus.CANCELLED && !input.refundFee) {
    throw new ConflictError('This job is already cancelled', 'ORDER_CANCELLED');
  }
  if (order.status === OrderStatus.DONE && !input.refundFee) {
    throw new ConflictError('A completed job cannot be cancelled', 'ORDER_COMPLETED');
  }

  const wasSearching = order.status === OrderStatus.PENDING || order.status === OrderStatus.MATCHING;
  const shouldCancel = order.status !== OrderStatus.DONE && order.status !== OrderStatus.CANCELLED;

  if (shouldCancel) {
    order.status = OrderStatus.CANCELLED;
    order.cancelReason = input.reason;
    order.cancelledBy = UserRole.ADMIN;
    order.cancelledAt = new Date();
    await order.save();

    if (wasSearching) await abortMatching(orderId);
    if (order.master) await Chat.updateOne({ order: order._id }, { $set: { isClosed: true } });

    const parties = [order.client.toString(), order.master?.toString()].filter(
      (party): party is string => Boolean(party),
    );
    await Promise.all(
      parties.map(async (party) => {
        emitToUser(party, SocketEvent.ORDER_CANCELLED, {
          orderId,
          reason: input.reason,
          cancelledBy: UserRole.ADMIN,
        });
        await notify({
          userId: party,
          type: NotificationType.ORDER_CANCELLED,
          orderId,
          data: { orderId },
        }).catch(() => undefined);
      }),
    );
  }

  const refund = input.refundFee ? await refundOrderFee(orderId) : null;
  if (!shouldCancel && !refund) {
    throw new ConflictError('This job has no unrefunded fee', 'NOTHING_TO_REFUND');
  }

  await record(
    adminId,
    shouldCancel ? AdminAction.ORDER_CANCELLED : AdminAction.ORDER_FEE_REFUNDED,
    AdminTarget.ORDER,
    orderId,
    `#${order.code}: ${input.reason}${refund ? ` (fee ${refund.amount} so'm refunded)` : ''}`,
    { reason: input.reason, refunded: refund?.amount ?? 0 },
  );

  return { order, refunded: refund?.amount ?? 0 };
};

/* ────────────────────────────── chats ────────────────────────────── */

export const listChats = async (
  input: ListChatsInput,
): Promise<Paginated<ChatDocument & { messageCount?: number }>> => {
  const filter: FilterQuery<IChat> = {};
  if (input.status === 'open') filter.isClosed = false;
  if (input.status === 'closed') filter.isClosed = true;
  if (input.user) filter.participants = oid(input.user);

  if (input.search) {
    const code = input.search.replace(/^#/, '').toUpperCase();
    const orders = await Order.find({
      $or: [{ code: new RegExp(`^${escapeRegex(code)}`) }, { title: contains(input.search) }],
    })
      .select('_id')
      .limit(500)
      .lean();
    filter.order = { $in: orders.map((order) => order._id) };
  }

  const skip = (input.page - 1) * input.limit;
  const [chats, total] = await Promise.all([
    Chat.find(filter)
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .populate('participants', PERSON)
      .populate('order', 'code title status')
      .populate('lastMessage', 'text kind sender createdAt')
      .exec(),
    Chat.countDocuments(filter),
  ]);

  const counts = await Message.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
    { $match: { chat: { $in: chats.map((chat) => chat._id) } } },
    { $group: { _id: '$chat', count: { $sum: 1 } } },
  ]);
  const countOf = new Map(counts.map((row) => [row._id.toString(), row.count]));

  const items = chats.map((chat) =>
    Object.assign(chat.toJSON(), { messageCount: countOf.get(chat._id.toString()) ?? 0 }),
  ) as unknown as Array<ChatDocument & { messageCount: number }>;

  return paginate(items, total, input.page, input.limit);
};

export const getChat = async (chatId: string): Promise<ChatDocument> => {
  const chat = await Chat.findById(chatId)
    .populate('participants', PERSON)
    .populate('order', 'code title status category createdAt');
  if (!chat) throw new NotFoundError('Chat');
  return chat;
};

/** Oldest-first within the page, so the thread reads top to bottom like the app. */
export const listMessages = async (
  chatId: string,
  page: number,
  limit: number,
): Promise<Paginated<IMessage>> => {
  const exists = await Chat.exists({ _id: chatId });
  if (!exists) throw new NotFoundError('Chat');

  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Message.find({ chat: chatId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('sender', 'firstName lastName role')
      .exec(),
    Message.countDocuments({ chat: chatId }),
  ]);

  return paginate(items.reverse() as unknown as IMessage[], total, page, limit);
};

export const setChatClosed = async (
  adminId: string,
  chatId: string,
  isClosed: boolean,
): Promise<ChatDocument> => {
  const chat = await Chat.findByIdAndUpdate(chatId, { $set: { isClosed } }, { new: true });
  if (!chat) throw new NotFoundError('Chat');
  await record(
    adminId,
    isClosed ? AdminAction.CHAT_CLOSED : AdminAction.CHAT_REOPENED,
    AdminTarget.CHAT,
    chatId,
    isClosed ? 'Chat closed' : 'Chat reopened',
  );
  return chat;
};

/**
 * Moderation removes a message outright — abuse, a phone scam, a leaked card
 * number. The chat's preview is rewound to the message before it.
 */
export const deleteMessage = async (adminId: string, messageId: string): Promise<void> => {
  const message = await Message.findByIdAndDelete(messageId);
  if (!message) throw new NotFoundError('Message');

  const chat = await Chat.findById(message.chat);
  if (chat && chat.lastMessage?.toString() === messageId) {
    const previous = await Message.findOne({ chat: chat._id }).sort({ createdAt: -1 });
    chat.lastMessage = previous?._id;
    chat.lastMessageAt = previous?.createdAt;
    await chat.save();
  }

  await record(adminId, AdminAction.MESSAGE_DELETED, AdminTarget.MESSAGE, messageId, 'Message deleted', {
    chatId: message.chat.toString(),
    senderId: message.sender.toString(),
    text: message.text.slice(0, 200),
  });
};

/* ───────────────────────────── products ──────────────────────────── */

export const listProducts = async (input: ListProductsInput): Promise<Paginated<ProductDocument>> => {
  const filter: FilterQuery<IProduct> = {};
  if (input.status === 'active') filter.isActive = true;
  if (input.status === 'hidden') filter.isActive = false;
  if (input.seller) filter.seller = oid(input.seller);
  if (input.search) {
    filter.$or = [{ title: contains(input.search) }, { category: contains(input.search) }];
  }

  const skip = (input.page - 1) * input.limit;
  const [items, total] = await Promise.all([
    Product.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .populate('seller', PERSON)
      .exec(),
    Product.countDocuments(filter),
  ]);

  return paginate(items, total, input.page, input.limit);
};

export const setProductActive = async (
  adminId: string,
  productId: string,
  isActive: boolean,
): Promise<ProductDocument> => {
  const product = await Product.findByIdAndUpdate(productId, { $set: { isActive } }, { new: true });
  if (!product) throw new NotFoundError('Product');
  await record(
    adminId,
    isActive ? AdminAction.PRODUCT_RESTORED : AdminAction.PRODUCT_HIDDEN,
    AdminTarget.PRODUCT,
    productId,
    `${isActive ? 'Restored' : 'Hid'} "${product.title}"`,
  );
  return product;
};

/* ───────────────────────────── reviews ───────────────────────────── */

type ReviewRow = ReturnType<ReviewDocument['toJSON']> & {
  targetName: string;
};

export const listReviews = async (input: ListReviewsInput): Promise<Paginated<ReviewRow>> => {
  const filter: FilterQuery<IReview> = {};
  if (input.targetType) filter.targetType = input.targetType;
  if (input.visible !== undefined) filter.isVisible = input.visible;
  if (input.stars) filter.stars = input.stars;
  if (input.author) filter.author = oid(input.author);

  const skip = (input.page - 1) * input.limit;
  const [reviews, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .populate('author', 'firstName lastName phone')
      .populate('order', 'code title')
      .exec(),
    Review.countDocuments(filter),
  ]);

  // `target` is polymorphic — a pro or a product — so it is resolved by hand.
  const masterIds = reviews.filter((r) => r.targetType === ReviewTarget.MASTER).map((r) => r.target);
  const productIds = reviews.filter((r) => r.targetType === ReviewTarget.PRODUCT).map((r) => r.target);
  const [masters, products] = await Promise.all([
    User.find({ _id: { $in: masterIds } }).select('firstName lastName').lean(),
    Product.find({ _id: { $in: productIds } }).select('title').lean(),
  ]);
  const names = new Map<string, string>([
    ...masters.map((m): [string, string] => [m._id.toString(), `${m.firstName} ${m.lastName}`]),
    ...products.map((p): [string, string] => [p._id.toString(), p.title]),
  ]);

  const items = reviews.map((review) => ({
    ...review.toJSON(),
    targetName: names.get(review.target.toString()) ?? '—',
  }));

  return paginate(items, total, input.page, input.limit);
};

export const setReviewVisible = async (
  adminId: string,
  reviewId: string,
  isVisible: boolean,
): Promise<ReviewDocument> => {
  const review = await Review.findByIdAndUpdate(reviewId, { $set: { isVisible } }, { new: true });
  if (!review) throw new NotFoundError('Review');
  // The rating is recomputed from visible reviews, so hiding one corrects it.
  await recomputeRating(review.targetType, review.target);
  await record(
    adminId,
    isVisible ? AdminAction.REVIEW_RESTORED : AdminAction.REVIEW_HIDDEN,
    AdminTarget.REVIEW,
    reviewId,
    `${isVisible ? 'Restored' : 'Hid'} a ${review.stars}★ review`,
  );
  return review;
};

/* ─────────────────────────── transactions ────────────────────────── */

export type TransactionTotals = Array<{ type: TransactionType; total: number; count: number }>;

export const listTransactions = async (
  input: ListTransactionsInput,
): Promise<Paginated<TransactionDocument> & { totals: TransactionTotals }> => {
  const filter: FilterQuery<ITransaction> = {};
  if (input.type) filter.type = input.type;
  if (input.status) filter.status = input.status;
  if (input.provider) filter.provider = input.provider;
  if (input.user) filter.user = oid(input.user);

  const skip = (input.page - 1) * input.limit;
  const [items, total, totals] = await Promise.all([
    Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .populate('user', PERSON)
      .populate('order', 'code title')
      .exec(),
    Transaction.countDocuments(filter),
    Transaction.aggregate<{ _id: TransactionType; total: number; count: number }>([
      { $match: filter },
      { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return {
    ...paginate(items, total, input.page, input.limit),
    totals: totals.map((row) => ({ type: row._id, total: row.total, count: row.count })),
  };
};

/* ──────────────────────────── broadcasts ─────────────────────────── */

/** Recipients notified concurrently per batch — enough to be quick, few enough not to flood FCM. */
const BROADCAST_BATCH = 50;

export const broadcast = async (
  adminId: string,
  input: BroadcastInput,
): Promise<{ recipients: number; delivered: number }> => {
  const filter: FilterQuery<IUser> = {
    isActive: true,
    isBlocked: false,
    role: input.audience === 'all' ? { $ne: UserRole.ADMIN } : input.audience,
  };
  const users = await User.find(filter).select('_id').lean();

  let delivered = 0;
  for (let start = 0; start < users.length; start += BROADCAST_BATCH) {
    const batch = users.slice(start, start + BROADCAST_BATCH);
    const results = await Promise.allSettled(
      batch.map((user) =>
        notify({
          userId: user._id.toString(),
          type: NotificationType.ANNOUNCEMENT,
          title: input.title,
          body: input.body,
          data: { kind: 'announcement' },
        }),
      ),
    );
    delivered += results.filter((result) => result.status === 'fulfilled').length;
  }

  await record(adminId, AdminAction.BROADCAST_SENT, AdminTarget.BROADCAST, null, input.title, {
    audience: input.audience,
    title: input.title,
    body: input.body,
    recipients: users.length,
    delivered,
  });

  return { recipients: users.length, delivered };
};

/* ───────────────────────────── journal ───────────────────────────── */

export const listLogs = async (input: ListLogsInput): Promise<Paginated<AdminLogDocument>> => {
  const filter: FilterQuery<AdminLogDocument> = {};
  if (input.action) filter.action = input.action;
  if (input.admin) filter.admin = oid(input.admin);

  const skip = (input.page - 1) * input.limit;
  const [items, total] = await Promise.all([
    AdminLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .populate('admin', 'firstName lastName phone')
      .exec(),
    AdminLog.countDocuments(filter),
  ]);

  return paginate(items, total, input.page, input.limit);
};
