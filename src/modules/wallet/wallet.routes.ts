import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { paginationSchema, validate } from '../../common/middlewares/validate.middleware';
import { asyncHandler, ok } from '../../common/utils/http';
import {
  PaymentProvider,
  UserRole,
  type AuthenticatedRequest,
  type TopUpProvider,
} from '../../common/types';
import { logger } from '../../config/logger';
import * as walletService from './wallet.service';
import { paymeCallback } from './payme.controller';

const topUpSchema = z.object({
  amount: z.coerce.number().int().positive(),
  provider: z.enum([PaymentProvider.PAYME, PaymentProvider.CLICK]),
});

export const walletRouter = Router();

walletRouter.get(
  '/',
  authenticate,
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    ok(res, await walletService.getBalance(req.user.id));
  }),
);

walletRouter.get(
  '/transactions',
  authenticate,
  validate({ query: paginationSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    ok(res, await walletService.listTransactions(req.user.id, page, limit));
  }),
);

walletRouter.post(
  '/top-up',
  authenticate,
  authorize(UserRole.MASTER, UserRole.SELLER),
  validate({ body: topUpSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const result = await walletService.startTopUp(
      req.user.id,
      req.body as { amount: number; provider: TopUpProvider },
    );
    ok(res, result);
  }),
);

/**
 * Provider callbacks. These are unauthenticated by nature — the provider has no
 * user token — so each one is verified by its own signature scheme before any
 * money moves.
 */
walletRouter.post(
  '/callback/click',
  asyncHandler(async (req, res) => {
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
    if (body.action === '1') {
      await walletService.confirmTopUp(body.merchant_trans_id ?? '', body.click_trans_id ?? '');
    }

    res.json({
      error: 0,
      error_note: 'Success',
      click_trans_id: body.click_trans_id,
      merchant_trans_id: body.merchant_trans_id,
    });
  }),
);

/**
 * Payme's Merchant API is a single JSON-RPC endpoint; the handler owns its own
 * error envelope, so it is mounted directly rather than through `asyncHandler`.
 */
walletRouter.post('/callback/payme', (req, res, next) => {
  void paymeCallback(req, res).catch(next);
});
