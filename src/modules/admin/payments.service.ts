import mongoose, { type FilterQuery } from 'mongoose';
import { logger } from '../../config/logger';
import { ConflictError, NotFoundError } from '../../common/errors/ApiError';
import {
  NotificationType,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  type Paginated,
} from '../../common/types';
import { paginate } from '../../common/utils/http';
import { User, type IUser } from '../user/user.model';
import { notify } from '../notification/notification.service';
import { Transaction, type ITransaction } from '../wallet/transaction.model';
import { emitWalletUpdated } from '../wallet/wallet.service';
import { AdminAction, AdminLog, AdminTarget } from './adminLog.model';
import type {
  ApprovePaymentInput,
  ListPaymentsInput,
  RejectPaymentInput,
} from './admin.validator';

/**
 * The admin "To'lovlar" queue: manual card-transfer top-ups that a pro filed
 * from the app and an admin approves or rejects by hand.
 */

const oid = (id: string): mongoose.Types.ObjectId => new mongoose.Types.ObjectId(id);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contains = (value: string): RegExp => new RegExp(escapeRegex(value), 'i');

const grouped = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const som = (value: number): string => `${grouped.format(value)} so'm`;

/** Only manual top-ups belong in this queue — never a Payme/Click checkout or a fee. */
const MANUAL_TOP_UP = { type: TransactionType.TOP_UP, provider: PaymentProvider.MANUAL } as const;

export type PaymentUser = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  balance: number;
};

export type PaymentRow = Omit<ITransaction, 'user'> & { id: string; user: PaymentUser | null };

type PopulatedUser = Pick<IUser, '_id' | 'firstName' | 'lastName' | 'phone' | 'balance'>;
type LeanPayment = Omit<ITransaction, 'user'> & { user: PopulatedUser | null };

const USER_FIELDS = 'firstName lastName phone balance';

const toRow = (item: LeanPayment): PaymentRow => ({
  ...item,
  id: String(item._id),
  user: item.user
    ? {
        id: String(item.user._id),
        firstName: item.user.firstName,
        lastName: item.user.lastName,
        phone: item.user.phone,
        balance: item.user.balance,
      }
    : null,
});

const loadRow = async (transactionId: mongoose.Types.ObjectId): Promise<PaymentRow> => {
  const item = await Transaction.findById(transactionId)
    .populate('user', USER_FIELDS)
    .lean<LeanPayment>();
  if (!item) throw new NotFoundError('Payment');
  return toRow(item);
};

/** Same journal shape as `admin.service` — a failed write never fails the action. */
const record = async (
  adminId: string,
  action: AdminAction,
  targetId: string,
  summary: string,
  meta: Record<string, unknown>,
): Promise<void> => {
  try {
    await AdminLog.create({
      admin: oid(adminId),
      action,
      targetType: AdminTarget.TRANSACTION,
      targetId: oid(targetId),
      summary: summary.length > 300 ? `${summary.slice(0, 299)}…` : summary,
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

const fullName = (user: { firstName?: string; lastName?: string } | null): string =>
  user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() : '';

export const listPayments = async (input: ListPaymentsInput): Promise<Paginated<PaymentRow>> => {
  const filter: FilterQuery<ITransaction> = { ...MANUAL_TOP_UP };
  if (input.status !== 'all') filter.status = input.status;

  if (input.search) {
    const or: FilterQuery<ITransaction>[] = [{ 'meta.payerNote': contains(input.search) }];
    if (/^[0-9a-fA-F]{24}$/.test(input.search)) {
      or.push({ _id: oid(input.search) }, { user: oid(input.search) });
    }

    const digits = input.search.replace(/\D/g, '');
    const userOr: FilterQuery<IUser>[] = [
      { firstName: contains(input.search) },
      { lastName: contains(input.search) },
    ];
    const [first, last] = input.search.split(/\s+/);
    if (first && last) userOr.push({ firstName: contains(first), lastName: contains(last) });
    if (digits.length >= 3) userOr.push({ phone: new RegExp(digits) });

    const users = await User.find({ $or: userOr }).select('_id').limit(500).lean();
    if (users.length > 0) or.push({ user: { $in: users.map((user) => user._id) } });
    filter.$or = or;
  }

  const skip = (input.page - 1) * input.limit;
  const [items, total] = await Promise.all([
    Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .populate('user', USER_FIELDS)
      .lean<LeanPayment[]>(),
    Transaction.countDocuments(filter),
  ]);

  return paginate(items.map(toRow), total, input.page, input.limit);
};

export const pendingCount = async (): Promise<{ count: number }> => ({
  count: await Transaction.countDocuments({ ...MANUAL_TOP_UP, status: TransactionStatus.PENDING }),
});

const notPending = (): ConflictError =>
  new ConflictError('This payment is no longer pending', 'PAYMENT_NOT_PENDING');

/**
 * Approves a manual top-up. The pending -> success flip is one conditional
 * update, so a double click or two admins at once cannot credit twice: the
 * loser finds nothing pending and gets 409. Only then is the balance moved.
 */
export const approvePayment = async (
  adminId: string,
  transactionId: string,
  input: ApprovePaymentInput,
): Promise<{ transaction: PaymentRow; balance: number }> => {
  const existing = await Transaction.findOne({ _id: transactionId, ...MANUAL_TOP_UP })
    .select('amount status')
    .lean();
  if (!existing) throw new NotFoundError('Payment');
  if (existing.status !== TransactionStatus.PENDING) throw notPending();

  const requested = existing.amount;
  const amount = input.amount ?? requested;
  const settledAt = new Date();

  const set: Record<string, unknown> = {
    status: TransactionStatus.SUCCESS,
    settledAt,
    'meta.approvedBy': adminId,
  };
  if (amount !== requested) {
    set.amount = amount;
    set['meta.requestedAmount'] = requested;
  }

  const claimed = await Transaction.findOneAndUpdate(
    { _id: transactionId, ...MANUAL_TOP_UP, status: TransactionStatus.PENDING },
    { $set: set },
    { new: true },
  );
  if (!claimed) throw notPending();

  const user = await User.findByIdAndUpdate(
    claimed.user,
    { $inc: { balance: amount } },
    { new: true },
  ).select('firstName lastName balance');
  if (!user) throw new NotFoundError('User');

  await Transaction.updateOne({ _id: claimed._id }, { $set: { balanceAfter: user.balance } });

  const userId = claimed.user.toString();
  await notify({
    userId,
    type: NotificationType.WALLET_TOPPED_UP,
    data: { amount: String(amount), balance: String(user.balance) },
  }).catch(() => undefined);
  emitWalletUpdated(userId, {
    transactionId: String(claimed._id),
    status: 'success',
    balance: user.balance,
  });

  await record(
    adminId,
    AdminAction.PAYMENT_APPROVED,
    String(claimed._id),
    `${fullName(user)}: +${som(amount)} tasdiqlandi${
      amount !== requested ? ` (so'ralgan ${som(requested)})` : ''
    }`,
    { userId, amount, requested, balanceAfter: user.balance },
  );

  return { transaction: await loadRow(claimed._id), balance: user.balance };
};

/** Rejects a manual top-up; the balance is never touched. */
export const rejectPayment = async (
  adminId: string,
  transactionId: string,
  input: RejectPaymentInput,
): Promise<{ transaction: PaymentRow }> => {
  const claimed = await Transaction.findOneAndUpdate(
    { _id: transactionId, ...MANUAL_TOP_UP, status: TransactionStatus.PENDING },
    {
      $set: {
        status: TransactionStatus.FAILED,
        settledAt: new Date(),
        'meta.rejectReason': input.reason,
        'meta.rejectedBy': adminId,
      },
    },
    { new: true },
  );
  if (!claimed) {
    const exists = await Transaction.exists({ _id: transactionId, ...MANUAL_TOP_UP });
    if (!exists) throw new NotFoundError('Payment');
    throw notPending();
  }

  const userId = claimed.user.toString();
  const user = await User.findById(claimed.user).select('firstName lastName balance').lean();

  await notify({
    userId,
    type: NotificationType.WALLET_TOP_UP_REJECTED,
    data: { amount: String(claimed.amount), reason: input.reason },
  }).catch(() => undefined);
  emitWalletUpdated(userId, {
    transactionId: String(claimed._id),
    status: 'failed',
    balance: user?.balance ?? 0,
  });

  await record(
    adminId,
    AdminAction.PAYMENT_REJECTED,
    String(claimed._id),
    `${fullName(user)}: ${som(claimed.amount)} rad etildi — ${input.reason}`,
    { userId, amount: claimed.amount, reason: input.reason },
  );

  return { transaction: await loadRow(claimed._id) };
};
