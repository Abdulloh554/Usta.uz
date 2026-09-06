import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { TransactionStatus } from '../../common/types';
import { Transaction } from './transaction.model';
import { confirmTopUp, failTopUp } from './wallet.service';

/**
 * Payme's Merchant API. Unlike Click's single callback, Payme speaks JSON-RPC
 * over one endpoint and expects its own error codes — HTTP is always 200 and the
 * outcome lives in the body, so this handler never throws to the error middleware.
 *
 * Reference: https://developer.help.paycom.uz/metody-merchant-api
 */

const ERROR = {
  INVALID_AMOUNT: -31001,
  ACCOUNT_NOT_FOUND: -31050,
  CANNOT_PERFORM: -31008,
  TRANSACTION_NOT_FOUND: -31003,
  UNAUTHORIZED: -32504,
} as const;

/** Payme state codes: 1 = created, 2 = paid, -1 = cancelled before payment, -2 = after. */
const STATE = {
  CREATED: 1,
  PAID: 2,
  CANCELLED: -1,
  CANCELLED_AFTER_PAY: -2,
} as const;

/** How the wallet's own status maps onto Payme's state codes. */
const PAYME_STATE_OF: Partial<Record<TransactionStatus, number>> = {
  [TransactionStatus.SUCCESS]: STATE.PAID,
  [TransactionStatus.FAILED]: STATE.CANCELLED,
  [TransactionStatus.PENDING]: STATE.CREATED,
};

type RpcRequest = {
  id?: number | string;
  method?: string;
  params?: {
    id?: string;
    time?: number;
    amount?: number;
    reason?: number;
    account?: { transaction_id?: string };
  };
};

const fail = (res: Response, id: RpcRequest['id'], code: number, message: string): void => {
  res.json({ id: id ?? null, error: { code, message } });
};

const succeed = (res: Response, id: RpcRequest['id'], result: Record<string, unknown>): void => {
  res.json({ id: id ?? null, result });
};

/**
 * Payme authenticates with HTTP Basic, where the password is the merchant key.
 * Compared in constant time so the endpoint cannot be probed by timing.
 */
const isAuthorised = (req: Request): boolean => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const key = decoded.slice(decoded.indexOf(':') + 1);

  const a = Buffer.from(key);
  const b = Buffer.from(env.PAYME_KEY);
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
};

export const paymeCallback = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as RpcRequest;
  const { id, method, params } = body;

  if (!isAuthorised(req)) {
    logger.warn('Rejected a Payme callback with bad credentials', { method });
    fail(res, id, ERROR.UNAUTHORIZED, 'Insufficient privileges');
    return;
  }

  // `account.transaction_id` is the pending transaction we created at checkout.
  const localId = params?.account?.transaction_id ?? params?.id;

  switch (method) {
    case 'CheckPerformTransaction': {
      const transaction = await Transaction.findById(params?.account?.transaction_id);
      if (!transaction) {
        fail(res, id, ERROR.ACCOUNT_NOT_FOUND, 'Transaction not found');
        return;
      }
      // Payme works in tiyin; the wallet works in so'm.
      if (params?.amount !== transaction.amount * 100) {
        fail(res, id, ERROR.INVALID_AMOUNT, 'Incorrect amount');
        return;
      }
      succeed(res, id, { allow: true });
      return;
    }

    case 'CreateTransaction': {
      const transaction = await Transaction.findById(params?.account?.transaction_id);
      if (!transaction) {
        fail(res, id, ERROR.ACCOUNT_NOT_FOUND, 'Transaction not found');
        return;
      }
      if (transaction.status === TransactionStatus.FAILED) {
        fail(res, id, ERROR.CANNOT_PERFORM, 'Transaction is closed');
        return;
      }

      // Record Payme's own id so a repeated call is recognised as the same one.
      if (!transaction.externalId && params?.id) {
        transaction.externalId = params.id;
        await transaction.save();
      }

      succeed(res, id, {
        create_time: transaction.createdAt.getTime(),
        transaction: String(transaction._id),
        state: transaction.status === TransactionStatus.SUCCESS ? STATE.PAID : STATE.CREATED,
      });
      return;
    }

    case 'PerformTransaction': {
      const transaction = await Transaction.findOne({ externalId: params?.id });
      if (!transaction) {
        fail(res, id, ERROR.TRANSACTION_NOT_FOUND, 'Transaction not found');
        return;
      }

      // `confirmTopUp` is idempotent, so a retried Perform credits only once.
      const settled = await confirmTopUp(String(transaction._id), params?.id ?? '');

      succeed(res, id, {
        transaction: String(settled._id),
        perform_time: settled.settledAt?.getTime() ?? Date.now(),
        state: STATE.PAID,
      });
      return;
    }

    case 'CancelTransaction': {
      const transaction = await Transaction.findOne({ externalId: params?.id });
      if (!transaction) {
        fail(res, id, ERROR.TRANSACTION_NOT_FOUND, 'Transaction not found');
        return;
      }

      // A top-up that already credited the wallet cannot simply be undone here —
      // the pro may have spent it. Refunds go through support, so this reports
      // the post-payment cancel state rather than silently reversing a balance.
      const alreadyPaid = transaction.status === TransactionStatus.SUCCESS;
      if (!alreadyPaid) {
        await failTopUp(String(transaction._id), `payme reason ${params?.reason ?? 'unknown'}`);
      }

      succeed(res, id, {
        transaction: String(transaction._id),
        cancel_time: Date.now(),
        state: alreadyPaid ? STATE.CANCELLED_AFTER_PAY : STATE.CANCELLED,
      });
      return;
    }

    case 'CheckTransaction': {
      const transaction = await Transaction.findOne({ externalId: params?.id });
      if (!transaction) {
        fail(res, id, ERROR.TRANSACTION_NOT_FOUND, 'Transaction not found');
        return;
      }

      succeed(res, id, {
        create_time: transaction.createdAt.getTime(),
        perform_time: transaction.settledAt?.getTime() ?? 0,
        cancel_time: 0,
        transaction: String(transaction._id),
        state: PAYME_STATE_OF[transaction.status] ?? STATE.CREATED,
        reason: null,
      });
      return;
    }

    default:
      logger.warn('Unknown Payme method', { method, localId });
      fail(res, id, ERROR.CANNOT_PERFORM, `Unknown method: ${String(method)}`);
  }
};
