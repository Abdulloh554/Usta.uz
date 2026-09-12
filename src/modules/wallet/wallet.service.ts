import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { env, paymentsEnabled } from '../../config/env';
import { logger } from '../../config/logger';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/ApiError';
import {
  NotificationType,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  type Paginated,
  type TopUpProvider,
} from '../../common/types';
import { paginate } from '../../common/utils/http';
import { User } from '../user/user.model';
import { notify } from '../notification/notification.service';
import { Transaction, type ITransaction, type TransactionDocument } from './transaction.model';

/** Smallest top-up accepted; below this the provider's own fee outweighs the payment. */
const MIN_TOP_UP = 1_000;
/** Largest single top-up — a typo'd extra zero should not become a real charge. */
const MAX_TOP_UP = 10_000_000;

export const getBalance = async (userId: string): Promise<{ balance: number; fee: number }> => {
  const user = await User.findById(userId).select('balance').lean();
  if (!user) throw new NotFoundError('User');
  return { balance: user.balance, fee: env.ORDER_ACCEPT_FEE };
};

export const listTransactions = async (
  userId: string,
  page: number,
  limit: number,
): Promise<Paginated<ITransaction>> => {
  const filter = { user: new mongoose.Types.ObjectId(userId) };
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<ITransaction[]>(),
    Transaction.countDocuments(filter),
  ]);

  // `.lean()` drops the `id` virtual; the app keys rows by it.
  return paginate(
    items.map((item) => ({ ...item, id: String(item._id) })),
    total,
    page,
    limit,
  );
};

export type TopUpInput = {
  amount: number;
  provider: TopUpProvider;
};

export type TopUpResult = {
  transactionId: string;
  /** Where the app sends the user to complete payment. */
  checkoutUrl: string;
  amount: number;
};

/** Payme takes its parameters base64-encoded, and amounts in tiyin. */
const buildPaymeUrl = (transactionId: string, amount: number): string => {
  const params = [
    `m=${env.PAYME_MERCHANT_ID}`,
    `ac.transaction_id=${transactionId}`,
    `a=${amount * 100}`,
  ].join(';');
  return `${env.PAYME_CHECKOUT_URL}/${Buffer.from(params).toString('base64')}`;
};

const buildClickUrl = (transactionId: string, amount: number): string => {
  const query = new URLSearchParams({
    service_id: env.CLICK_SERVICE_ID,
    merchant_id: env.CLICK_MERCHANT_ID,
    amount: String(amount),
    transaction_param: transactionId,
  });
  return `${env.CLICK_CHECKOUT_URL}?${query.toString()}`;
};

/**
 * Opens a top-up. The transaction is recorded as `pending` and the balance is
 * untouched — money only moves when the provider confirms, so an abandoned
 * checkout leaves nothing to reconcile.
 */
export const startTopUp = async (userId: string, input: TopUpInput): Promise<TopUpResult> => {
  // Nothing costs money while payments are off, so there is nothing to top up for.
  if (!paymentsEnabled()) {
    throw new ForbiddenError('Payments are turned off for now', 'PAYMENTS_DISABLED');
  }
  if (input.amount < MIN_TOP_UP) {
    throw new BadRequestError(`The smallest top-up is ${MIN_TOP_UP} so'm`, [
      { field: 'amount', message: 'below_minimum' },
    ]);
  }
  if (input.amount > MAX_TOP_UP) {
    throw new BadRequestError(`The largest top-up is ${MAX_TOP_UP} so'm`, [
      { field: 'amount', message: 'above_maximum' },
    ]);
  }

  const user = await User.findById(userId).select('_id').lean();
  if (!user) throw new NotFoundError('User');

  const transaction = await Transaction.create({
    user: new mongoose.Types.ObjectId(userId),
    type: TransactionType.TOP_UP,
    status: TransactionStatus.PENDING,
    provider: input.provider,
    amount: input.amount,
    description: 'Wallet top-up',
  });

  const transactionId = (transaction._id).toString();
  const checkoutUrl =
    input.provider === PaymentProvider.PAYME
      ? buildPaymeUrl(transactionId, input.amount)
      : buildClickUrl(transactionId, input.amount);

  logger.info('Top-up started', { userId, amount: input.amount, provider: input.provider });
  return { transactionId, checkoutUrl, amount: input.amount };
};

/** Click signs each callback; a mismatched digest means the request is not theirs. */
export const verifyClickSignature = (payload: {
  clickTransId: string;
  serviceId: string;
  merchantTransId: string;
  amount: string;
  action: string;
  signTime: string;
  signString: string;
}): boolean => {
  const expected = crypto
    .createHash('md5')
    .update(
      [
        payload.clickTransId,
        payload.serviceId,
        env.CLICK_SECRET_KEY,
        payload.merchantTransId,
        payload.amount,
        payload.action,
        payload.signTime,
      ].join(''),
    )
    .digest('hex');

  // Constant-time comparison: a fast `!==` leaks digest bytes through timing.
  const a = Buffer.from(expected);
  const b = Buffer.from(payload.signString);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/**
 * Settles a pending top-up. Providers retry callbacks, so this is idempotent:
 * an already-settled transaction returns as-is rather than crediting twice.
 */
export const confirmTopUp = async (
  transactionId: string,
  externalId: string,
): Promise<TransactionDocument> => {
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) throw new NotFoundError('Transaction');

  if (transaction.status === TransactionStatus.SUCCESS) return transaction;
  if (transaction.status !== TransactionStatus.PENDING) {
    throw new ConflictError('This payment can no longer be settled', 'TRANSACTION_CLOSED');
  }

  const user = await User.findByIdAndUpdate(
    transaction.user,
    { $inc: { balance: transaction.amount } },
    { new: true },
  );
  if (!user) throw new NotFoundError('User');

  transaction.status = TransactionStatus.SUCCESS;
  transaction.externalId = externalId;
  transaction.balanceAfter = user.balance;
  transaction.settledAt = new Date();
  await transaction.save();

  await notify({
    userId: transaction.user.toString(),
    type: NotificationType.WALLET_TOPPED_UP,
    data: { amount: String(transaction.amount), balance: String(user.balance) },
  }).catch(() => undefined);

  logger.info('Top-up settled', {
    transactionId,
    userId: transaction.user.toString(),
    amount: transaction.amount,
  });
  return transaction;
};

export const failTopUp = async (transactionId: string, reason: string): Promise<void> => {
  await Transaction.updateOne(
    { _id: transactionId, status: TransactionStatus.PENDING },
    { $set: { status: TransactionStatus.FAILED, meta: { reason } } },
  );
};

/**
 * Refunds a job fee — used when a pro cancels a job they accepted and support
 * rules the fee back. Guarded so one job fee can only ever be refunded once.
 */
export const refundOrderFee = async (orderId: string): Promise<TransactionDocument | null> => {
  const fee = await Transaction.findOne({
    order: orderId,
    type: TransactionType.ORDER_FEE,
    status: TransactionStatus.SUCCESS,
  });
  if (!fee) return null;

  const alreadyRefunded = await Transaction.exists({
    order: orderId,
    type: TransactionType.REFUND,
    status: TransactionStatus.SUCCESS,
  });
  if (alreadyRefunded) return null;

  const amount = Math.abs(fee.amount);
  const user = await User.findByIdAndUpdate(fee.user, { $inc: { balance: amount } }, { new: true });
  if (!user) throw new NotFoundError('User');

  const refund = await Transaction.create({
    user: fee.user,
    type: TransactionType.REFUND,
    status: TransactionStatus.SUCCESS,
    provider: PaymentProvider.BALANCE,
    amount,
    balanceAfter: user.balance,
    order: fee.order,
    description: 'Job fee refunded',
    settledAt: new Date(),
  });

  logger.info('Job fee refunded', { orderId, amount, userId: fee.user.toString() });
  return refund;
};
