import type { RequestHandler } from 'express';
import { asyncHandler, created, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import { logger } from '../../config/logger';
import * as walletService from './wallet.service';
import { paymeCallback } from './payme.controller';
import type { TopUpInput, TopUpRequestInput, TransactionsQuery } from './wallet.validator';

export const balance = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await walletService.getBalance(req.user.id));
});

export const transactions = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { page, limit } = req.query as unknown as TransactionsQuery;
  ok(res, await walletService.listTransactions(req.user.id, page, limit));
});

export const startTopUp = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await walletService.startTopUp(req.user.id, req.body as TopUpInput));
});

export const createTopUpRequest = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  created(res, await walletService.createTopUpRequest(req.user.id, req.body as TopUpRequestInput));
});

/* — provider callbacks — */

export const clickCallback = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, string>;

  const valid = walletService.verifyClickSignature({
    clickTransId: body.click_trans_id ?? '',
    serviceId: body.service_id ?? '',
    merchantTransId: body.merchant_trans_id ?? '',
    amount: body.amount ?? '',
    action: body.action ?? '',
    signTime: body.sign_time ?? '',
    signString: body.sign_string ?? '',
  });

  if (!valid) {
    logger.warn('Rejected a Click callback with a bad signature', {
      merchantTransId: body.merchant_trans_id,
    });
    res.json({ error: -1, error_note: 'SIGN CHECK FAILED' });
    return;
  }

  // action 0 = prepare (reserve), action 1 = complete (settle).
  res.json(await walletService.handleClickCallback(body));
});

/**
 * Payme's Merchant API is a single JSON-RPC endpoint; the handler owns its own
 * error envelope, so it is wrapped directly rather than through `asyncHandler`.
 */
export const paymeWebhook: RequestHandler = (req, res, next) => {
  void paymeCallback(req, res).catch(next);
};
