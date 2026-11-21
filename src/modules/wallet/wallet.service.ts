import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { clickConfigured, env, paymeConfigured, paymentsEnabled } from '../../config/env';
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
  type CheckoutProvider,
  type Paginated,
} from '../../common/types';
import { paginate } from '../../common/utils/http';
import { User } from '../user/user.model';
import { notify } from '../notification/notification.service';
import { emitToUser } from '../../sockets/emitter';
import { SocketEvent, type WalletUpdatedPayload } from '../../sockets/events';
import { Transaction, type ITransaction, type TransactionDocument } from './transaction.model';

/** Smallest top-up accepted; below this the provider's own fee outweighs the payment. */
export const MIN_TOP_UP = 1_000;
/** Largest single top-up — a typo'd extra zero should not become a real charge. */
export const MAX_TOP_UP = 10_000_000;

export type WalletSummary = {
  balance: number;
  fee: number;
  /** Where the pro transfers money for a manual top-up. Empty strings when unset. */
  manualPayment: { card: string; holder: string; note: string };
  /** The request still waiting for an admin, if there is one. */
  pendingTopUp: { id: string; amount: number; createdAt: Date } | null;
};

/** The filter for a manual top-up request still waiting for an admin. */
const pendingManualFilter = (userId: string) => ({
  user: new mongoose.Types.ObjectId(userId),
  type: TransactionType.TOP_UP,
  provider: PaymentProvider.MANUAL,
  status: TransactionStatus.PENDING,
});

export const getBalance = async (userId: string): Promise<WalletSummary> => {
  const [user, pending] = await Promise.all([
    User.findById(userId).select('balance').lean(),
    Transaction.findOne(pendingManualFilter(userId))
      .select('amount createdAt')
      .lean<Pick<ITransaction, '_id' | 'amount' | 'createdAt'>>(),
  ]);
  if (!user) throw new NotFoundError('User');
  return {
    balance: user.balance,
    fee: env.ORDER_ACCEPT_FEE,
    manualPayment: {
      card: env.MANUAL_PAYMENT_CARD,
      holder: env.MANUAL_PAYMENT_HOLDER,
      note: env.MANUAL_PAYMENT_NOTE,
    },
    pendingTopUp: pending
      ? { id: String(pending._id), amount: pending.amount, createdAt: pending.createdAt }
      : null,
  };
};

/** Tells every device the user is signed in on that the wallet changed. */
export const emitWalletUpdated = (userId: string, payload: WalletUpdatedPayload): void => {
  emitToUser(userId, SocketEvent.WALLET_UPDATED, payload);
};

export type TopUpRequestInput = { amount: number; payerNote: string };

export type TopUpRequestResult = {
  id: string;
  amount: number;
  status: typeof TransactionStatus.PENDING;
  createdAt: Date;
};

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000;

/**
 * Files a manual top-up: the pro says they transferred `amount` to the card on
 * `GET /wallet`, and an admin confirms it from the panel. Nothing moves until
 * then. One open request per user — the partial unique index enforces it even
 * when two requests race past the check below.
 */
export const createTopUpRequest = async (
  userId: string,
  input: TopUpRequestInput,
): Promise<TopUpRequestResult> => {
  if (!paymentsEnabled()) {
    throw new ForbiddenError('Payments are turned off for now', 'PAYMENTS_DISABLED');
  }

  const user = await User.findById(userId).select('_id').lean();
  if (!user) throw new NotFoundError('User');

  const pendingError = (): ConflictError =>
    new ConflictError('A top-up request is already waiting for review', 'TOP_UP_PENDING');

  if (await Transaction.exists(pendingManualFilter(userId))) throw pendingError();

  let transaction: TransactionDocument;
  try {
    transaction = await Transaction.create({
      user: new mongoose.Types.ObjectId(userId),
      type: TransactionType.TOP_UP,
      status: TransactionStatus.PENDING,
      provider: PaymentProvider.MANUAL,
      amount: input.amount,
      description: 'Wallet top-up (card transfer)',
      meta: { payerNote: input.payerNote },
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw pendingError();
    throw error;
  }

  logger.info('Manual top-up requested', { userId, amount: input.amount });
  return {
    id: String(transaction._id),
    amount: transaction.amount,
    status: TransactionStatus.PENDING,
    createdAt: transaction.createdAt,
  };
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
  provider: CheckoutProvider;
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
  const configured =
    input.provider === PaymentProvider.PAYME ? paymeConfigured() : clickConfigured();
  if (!configured) {
    throw new ForbiddenError('This payment provider is not available', 'PROVIDER_UNAVAILABLE');
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

  const transactionId = transaction._id.toString();
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
  // Without a secret every digest is forgeable — refuse rather than accept.
  if (!env.CLICK_SECRET_KEY) return false;

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

export const failTopUp = async (transactionId: string, reason: string): Promise<void> => {
  await Transaction.updateOne(
    { _id: transactionId, status: TransactionStatus.PENDING },
    { $set: { status: TransactionStatus.FAILED, meta: { reason } } },
  );
};

/** Only online checkouts settle through provider callbacks; manual ones go through an admin. */
const CHECKOUT_PROVIDERS: CheckoutProvider[] = [PaymentProvider.PAYME, PaymentProvider.CLICK];

/**
 * Settles a pending top-up. Providers retry callbacks, so this is idempotent:
 * an already-settled transaction returns as-is rather than crediting twice.
 * The pending -> success flip is a single conditional update, so two callbacks
 * racing each other cannot both credit the wallet. Only `top_up` rows from an
 * online provider qualify — a fee, refund or manual request never settles here.
 */
export const confirmTopUp = async (
  transactionId: string,
  externalId: string,
): Promise<TransactionDocument> => {
  if (!mongoose.isValidObjectId(transactionId)) throw new NotFoundError('Transaction');

  const scope = {
    _id: transactionId,
    type: TransactionType.TOP_UP,
    provider: { $in: CHECKOUT_PROVIDERS },
  };

  const claimed = await Transaction.findOneAndUpdate(
    { ...scope, status: TransactionStatus.PENDING },
    { $set: { status: TransactionStatus.SUCCESS, externalId, settledAt: new Date() } },
    { new: true },
  );

  if (!claimed) {
    const existing = await Transaction.findOne(scope);
    if (!existing) throw new NotFoundError('Transaction');
    if (existing.status === TransactionStatus.SUCCESS) return existing;
    throw new ConflictError('This payment can no longer be settled', 'TRANSACTION_CLOSED');
  }

  const user = await User.findByIdAndUpdate(
    claimed.user,
    { $inc: { balance: claimed.amount } },
    { new: true },
  );
  if (!user) throw new NotFoundError('User');

  claimed.balanceAfter = user.balance;
  await claimed.save();

  await notify({
    userId: claimed.user.toString(),
    type: NotificationType.WALLET_TOPPED_UP,
    data: { amount: String(claimed.amount), balance: String(user.balance) },
  }).catch(() => undefined);
  emitWalletUpdated(claimed.user.toString(), {
    transactionId: String(claimed._id),
    status: 'success',
    balance: user.balance,
  });

  logger.info('Top-up settled', {
    transactionId,
    userId: claimed.user.toString(),
    amount: claimed.amount,
  });
  return claimed;
};

export type ClickCallbackBody = Record<string, string | undefined>;
export type ClickCallbackReply = Record<string, string | number | undefined>;

/**
 * Handles a Click callback whose signature the caller already verified
 * (prepare = action 0, complete = action 1). Checks that the transaction is a
 * real Click top-up for exactly the amount Click reports, and never credits a
 * completion Click itself marks as failed (`error` < 0).
 *
 * Error codes per Click's SHOP API: -2 wrong amount, -4 already paid,
 * -5 unknown transaction, -9 cancelled.
 */
export const handleClickCallback = async (body: ClickCallbackBody): Promise<ClickCallbackReply> => {
  const merchantTransId = body.merchant_trans_id ?? '';
  const clickTransId = body.click_trans_id ?? '';
  const reply = (error: number, note: string): ClickCallbackReply => ({
    error,
    error_note: note,
    click_trans_id: clickTransId,
    merchant_trans_id: merchantTransId,
  });

  const transaction = mongoose.isValidObjectId(merchantTransId)
    ? await Transaction.findOne({
        _id: merchantTransId,
        type: TransactionType.TOP_UP,
        provider: PaymentProvider.CLICK,
      })
    : null;
  if (!transaction) return reply(-5, 'Transaction not found');

  if (Number(body.amount) !== transaction.amount) return reply(-2, 'Incorrect amount');
  if (transaction.status === TransactionStatus.FAILED) return reply(-9, 'Transaction cancelled');

  if (body.action !== '1') {
    if (transaction.status === TransactionStatus.SUCCESS) return reply(-4, 'Already paid');
    return reply(0, 'Success');
  }

  // Click reports its own failure on completion with a negative `error`.
  const clickError = Number(body.error ?? 0);
  if (Number.isNaN(clickError) || clickError < 0) {
    if (transaction.status === TransactionStatus.PENDING) {
      await failTopUp(String(transaction._id), `click error ${body.error ?? ''}`);
    }
    return reply(-9, 'Transaction cancelled');
  }

  await confirmTopUp(String(transaction._id), clickTransId);
  return reply(0, 'Success');
};

/**
 * Refunds a job fee — used when a pro cancels a job they accepted and support
 * rules the fee back. One job fee can only ever be refunded once: the fee row
 * is claimed with a single conditional update (`meta.refundedAt`), so two
 * parallel calls cannot both pass the guard and credit the pro twice.
 */
export const refundOrderFee = async (orderId: string): Promise<TransactionDocument | null> => {
  if (!mongoose.isValidObjectId(orderId)) return null;

  // Refunds recorded before the claim marker existed still count as refunded.
  const alreadyRefunded = await Transaction.exists({
    order: orderId,
    type: TransactionType.REFUND,
    status: TransactionStatus.SUCCESS,
  });
  if (alreadyRefunded) return null;

  const refundedAt = new Date();
  const fee = await Transaction.findOneAndUpdate(
    {
      order: orderId,
      type: TransactionType.ORDER_FEE,
      status: TransactionStatus.SUCCESS,
      'meta.refundedAt': { $exists: false },
    },
    { $set: { 'meta.refundedAt': refundedAt } },
    { new: true },
  );
  if (!fee) return null;

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
    settledAt: refundedAt,
  });

  logger.info('Job fee refunded', { orderId, amount, userId: fee.user.toString() });
  return refund;
};
