import mongoose, { type PipelineStage } from 'mongoose';
import { env } from '../../config/env';
import { redis } from '../../config/redis';
import {
  OrderCategory,
  OrderStatus,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
  type Craft,
} from '../../common/types';
import { User } from '../user/user.model';
import { MasterProfile } from '../user/masterProfile.model';
import { Order } from '../order/order.model';
import { Chat, Message } from '../chat/chat.model';
import { Product } from '../product/product.model';
import { Review } from '../review/review.model';
import { Transaction } from '../wallet/transaction.model';

/**
 * Uzbekistan has a fixed UTC+5 offset and no daylight saving, so a "day" on the
 * dashboard is a Tashkent calendar day — not the server's, and not UTC's, which
 * would split a Tashkent evening across two bars.
 */
const TIMEZONE = 'Asia/Tashkent';
const TZ_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const startOfTashkentDay = (at: Date = new Date()): Date =>
  new Date(Math.floor((at.getTime() + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS);

const dayKey = (at: Date): string => new Date(at.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);

const daysAgo = (days: number): Date => new Date(startOfTashkentDay().getTime() - days * DAY_MS);

type CountRow = { _id: string; count: number };
type SumRow = { _id: string | null; total: number; count: number };

const countBy = async (
  aggregate: (pipeline: PipelineStage[]) => Promise<CountRow[]>,
  field: string,
  match: Record<string, unknown> = {},
): Promise<Record<string, number>> => {
  const rows = await aggregate([{ $match: match }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
};

/** Fills every enum member, so the client never has to guess at a missing zero. */
const withZeros = <K extends string>(keys: readonly K[], counts: Record<string, number>): Record<K, number> =>
  Object.fromEntries(keys.map((key) => [key, counts[key] ?? 0])) as Record<K, number>;

const sumTransactions = async (match: Record<string, unknown>): Promise<{ total: number; count: number }> => {
  const [row] = await Transaction.aggregate<SumRow>([
    { $match: match },
    { $group: { _id: null, total: { $sum: { $abs: '$amount' } }, count: { $sum: 1 } } },
  ]);
  return { total: row?.total ?? 0, count: row?.count ?? 0 };
};

export type Overview = {
  users: {
    total: number;
    byRole: Record<UserRole, number>;
    blocked: number;
    inactive: number;
    newToday: number;
    new7d: number;
    new30d: number;
    /** Distinct users who signed in or were seen in the last 24 hours. */
    activeToday: number;
    mastersOnline: number;
  };
  orders: {
    total: number;
    today: number;
    byStatus: Record<OrderStatus, number>;
    byCategory: Record<OrderCategory, number>;
    /** Share of jobs that ended `done`, among those that have ended at all. */
    completionRate: number;
  };
  finance: {
    /** What the platform earned: settled job fees minus refunds. */
    netRevenue: number;
    feeRevenue: number;
    feeCount: number;
    refunds: number;
    revenueToday: number;
    revenue30d: number;
    /** Money users paid in through Payme / Click. */
    topUps: number;
    topUpCount: number;
    pendingTopUps: number;
    adjustments: number;
    /** Everything currently sitting in wallets — money owed back to users. */
    walletBalances: number;
    fee: number;
  };
  products: { total: number; active: number; hidden: number; outOfStock: number; sold: number };
  chats: { total: number; open: number; messages: number; messagesToday: number };
  reviews: { total: number; hidden: number; averageStars: number };
};

export const overview = async (): Promise<Overview> => {
  const today = startOfTashkentDay();
  const week = daysAgo(7);
  const month = daysAgo(30);
  const yesterday = new Date(Date.now() - DAY_MS);

  const settledFee = { type: TransactionType.ORDER_FEE, status: TransactionStatus.SUCCESS };
  const settledRefund = { type: TransactionType.REFUND, status: TransactionStatus.SUCCESS };

  const [
    usersTotal,
    byRole,
    blocked,
    inactive,
    newToday,
    new7d,
    new30d,
    activeToday,
    mastersOnline,
    ordersTotal,
    ordersToday,
    byStatus,
    byCategory,
    fees,
    refunds,
    feesToday,
    refundsToday,
    fees30d,
    refunds30d,
    topUps,
    pendingTopUps,
    adjustments,
    walletRows,
    productsTotal,
    productsActive,
    outOfStock,
    soldRows,
    chatsTotal,
    chatsOpen,
    messages,
    messagesToday,
    reviewsTotal,
    reviewsHidden,
    starRows,
  ] = await Promise.all([
    User.countDocuments(),
    countBy((pipeline) => User.aggregate<CountRow>(pipeline), 'role'),
    User.countDocuments({ isBlocked: true }),
    User.countDocuments({ isActive: false }),
    User.countDocuments({ createdAt: { $gte: today } }),
    User.countDocuments({ createdAt: { $gte: week } }),
    User.countDocuments({ createdAt: { $gte: month } }),
    User.countDocuments({ lastSeenAt: { $gte: yesterday } }),
    MasterProfile.countDocuments({ isOnline: true }),
    Order.countDocuments(),
    Order.countDocuments({ createdAt: { $gte: today } }),
    countBy((pipeline) => Order.aggregate<CountRow>(pipeline), 'status'),
    countBy((pipeline) => Order.aggregate<CountRow>(pipeline), 'category'),
    sumTransactions(settledFee),
    sumTransactions(settledRefund),
    sumTransactions({ ...settledFee, createdAt: { $gte: today } }),
    sumTransactions({ ...settledRefund, createdAt: { $gte: today } }),
    sumTransactions({ ...settledFee, createdAt: { $gte: month } }),
    sumTransactions({ ...settledRefund, createdAt: { $gte: month } }),
    sumTransactions({ type: TransactionType.TOP_UP, status: TransactionStatus.SUCCESS }),
    Transaction.countDocuments({ type: TransactionType.TOP_UP, status: TransactionStatus.PENDING }),
    Transaction.aggregate<SumRow>([
      { $match: { type: TransactionType.ADJUSTMENT, status: TransactionStatus.SUCCESS } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    User.aggregate<SumRow>([{ $group: { _id: null, total: { $sum: '$balance' }, count: { $sum: 1 } } }]),
    Product.countDocuments(),
    Product.countDocuments({ isActive: true }),
    Product.countDocuments({ isActive: true, stock: 0 }),
    Product.aggregate<SumRow>([{ $group: { _id: null, total: { $sum: '$soldCount' }, count: { $sum: 1 } } }]),
    Chat.countDocuments(),
    Chat.countDocuments({ isClosed: false }),
    Message.estimatedDocumentCount(),
    Message.countDocuments({ createdAt: { $gte: today } }),
    Review.countDocuments(),
    Review.countDocuments({ isVisible: false }),
    Review.aggregate<SumRow>([
      { $match: { isVisible: true } },
      { $group: { _id: null, total: { $avg: '$stars' }, count: { $sum: 1 } } },
    ]),
  ]);

  const statusCounts = withZeros(Object.values(OrderStatus), byStatus);
  const ended = statusCounts.done + statusCounts.cancelled;

  return {
    users: {
      total: usersTotal,
      byRole: withZeros(Object.values(UserRole), byRole),
      blocked,
      inactive,
      newToday,
      new7d,
      new30d,
      activeToday,
      mastersOnline,
    },
    orders: {
      total: ordersTotal,
      today: ordersToday,
      byStatus: statusCounts,
      byCategory: withZeros(Object.values(OrderCategory), byCategory),
      completionRate: ended === 0 ? 0 : Math.round((statusCounts.done / ended) * 1000) / 10,
    },
    finance: {
      netRevenue: fees.total - refunds.total,
      feeRevenue: fees.total,
      feeCount: fees.count,
      refunds: refunds.total,
      revenueToday: feesToday.total - refundsToday.total,
      revenue30d: fees30d.total - refunds30d.total,
      topUps: topUps.total,
      topUpCount: topUps.count,
      pendingTopUps,
      adjustments: adjustments[0]?.total ?? 0,
      walletBalances: walletRows[0]?.total ?? 0,
      fee: env.ORDER_ACCEPT_FEE,
    },
    products: {
      total: productsTotal,
      active: productsActive,
      hidden: productsTotal - productsActive,
      outOfStock,
      sold: soldRows[0]?.total ?? 0,
    },
    chats: { total: chatsTotal, open: chatsOpen, messages, messagesToday },
    reviews: {
      total: reviewsTotal,
      hidden: reviewsHidden,
      averageStars: starRows[0] ? Math.round(starRows[0].total * 10) / 10 : 0,
    },
  };
};

export type TimeseriesPoint = {
  date: string;
  users: number;
  orders: number;
  completed: number;
  revenue: number;
  topUps: number;
  messages: number;
};

const byDay = (field: string): Record<string, unknown> => ({
  $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: TIMEZONE },
});

const dailyCounts = async (
  aggregate: (pipeline: PipelineStage[]) => Promise<CountRow[]>,
  field: string,
  since: Date,
  match: Record<string, unknown> = {},
): Promise<Map<string, number>> => {
  const rows = await aggregate([
    { $match: { ...match, [field]: { $gte: since } } },
    { $group: { _id: byDay(field), count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
};

const dailySums = async (since: Date, match: Record<string, unknown>): Promise<Map<string, number>> => {
  const rows = await Transaction.aggregate<CountRow>([
    { $match: { ...match, createdAt: { $gte: since } } },
    { $group: { _id: byDay('createdAt'), count: { $sum: '$amount' } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
};

/** One row per Tashkent day, oldest first, with zeros where nothing happened. */
export const timeseries = async (days: number): Promise<TimeseriesPoint[]> => {
  const since = daysAgo(days - 1);

  const [users, orders, completed, fees, refunds, topUps, messages] = await Promise.all([
    dailyCounts((pipeline) => User.aggregate<CountRow>(pipeline), 'createdAt', since),
    dailyCounts((pipeline) => Order.aggregate<CountRow>(pipeline), 'createdAt', since),
    dailyCounts((pipeline) => Order.aggregate<CountRow>(pipeline), 'completedAt', since, {
      status: OrderStatus.DONE,
    }),
    dailySums(since, { type: TransactionType.ORDER_FEE, status: TransactionStatus.SUCCESS }),
    dailySums(since, { type: TransactionType.REFUND, status: TransactionStatus.SUCCESS }),
    dailySums(since, { type: TransactionType.TOP_UP, status: TransactionStatus.SUCCESS }),
    dailyCounts((pipeline) => Message.aggregate<CountRow>(pipeline), 'createdAt', since),
  ]);

  return Array.from({ length: days }, (_unused, index) => {
    const date = dayKey(new Date(since.getTime() + index * DAY_MS));
    // Fees are stored as debits (negative) and refunds as credits; the platform's
    // revenue for the day is what it kept.
    const revenue = Math.abs(fees.get(date) ?? 0) - Math.abs(refunds.get(date) ?? 0);
    return {
      date,
      users: users.get(date) ?? 0,
      orders: orders.get(date) ?? 0,
      completed: completed.get(date) ?? 0,
      revenue,
      topUps: topUps.get(date) ?? 0,
      messages: messages.get(date) ?? 0,
    };
  });
};

export type TopMasterRow = {
  id: string;
  name: string;
  phone: string;
  crafts: Craft[];
  rating: number;
  ratingCount: number;
  completedJobs: number;
  cancelledJobs: number;
  isOnline: boolean;
};

export const topMasters = async (limit = 10): Promise<TopMasterRow[]> => {
  const rows = await MasterProfile.aggregate<{
    user: mongoose.Types.ObjectId;
    crafts: Craft[];
    rating: number;
    ratingCount: number;
    completedJobs: number;
    cancelledJobs: number;
    isOnline: boolean;
    account: { firstName: string; lastName: string; phone: string };
  }>([
    { $sort: { completedJobs: -1, rating: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: User.collection.name,
        localField: 'user',
        foreignField: '_id',
        as: 'account',
        pipeline: [{ $project: { firstName: 1, lastName: 1, phone: 1 } }],
      },
    },
    { $unwind: '$account' },
  ]);

  return rows.map((row) => ({
    id: row.user.toString(),
    name: `${row.account.firstName} ${row.account.lastName}`,
    phone: row.account.phone,
    crafts: row.crafts,
    rating: row.rating,
    ratingCount: row.ratingCount,
    completedJobs: row.completedJobs,
    cancelledJobs: row.cancelledJobs,
    isOnline: row.isOnline,
  }));
};

export type SystemInfo = {
  mongo: 'up' | 'down';
  redis: string;
  uptimeSeconds: number;
  nodeVersion: string;
  env: string;
  fee: number;
  smsProvider: string;
  matching: { offerTimeoutSeconds: number; maxCandidates: number; radiusKm: number };
  integrations: Record<'payme' | 'click' | 'cloudinary' | 'fcm' | 'sentry', boolean>;
  providers: string[];
};

/** Read-only settings page: what the running process is configured with, never the secrets. */
export const systemInfo = (): SystemInfo => ({
  mongo: mongoose.connection.readyState === 1 ? 'up' : 'down',
  redis: redis.status === 'ready' ? 'up' : redis.status,
  uptimeSeconds: Math.floor(process.uptime()),
  nodeVersion: process.version,
  env: env.NODE_ENV,
  fee: env.ORDER_ACCEPT_FEE,
  smsProvider: env.SMS_PROVIDER,
  matching: {
    offerTimeoutSeconds: env.MATCH_OFFER_TIMEOUT_SECONDS,
    maxCandidates: env.MATCH_MAX_CANDIDATES,
    radiusKm: env.MATCH_RADIUS_KM,
  },
  integrations: {
    payme: Boolean(env.PAYME_MERCHANT_ID && env.PAYME_KEY),
    click: Boolean(env.CLICK_MERCHANT_ID && env.CLICK_SECRET_KEY),
    cloudinary: Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY),
    fcm: Boolean(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL),
    sentry: Boolean(env.SENTRY_DSN),
  },
  providers: Object.values(PaymentProvider),
});
