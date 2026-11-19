import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { paginationSchema, validate } from '../../common/middlewares/validate.middleware';
import {
  topUpRequestLimiter,
  webhookLimiter,
} from '../../common/middlewares/rateLimit.middleware';
import { asyncHandler, created, ok } from '../../common/utils/http';
import {
  PaymentProvider,
  UserRole,
  type AuthenticatedRequest,
  type CheckoutProvider,
} from '../../common/types';
import { logger } from '../../config/logger';
import * as walletService from './wallet.service';
import { paymeCallback } from './payme.controller';

const topUpSchema = z.object({
  amount: z.coerce.number().int().positive(),
  provider: z.enum([PaymentProvider.PAYME, PaymentProvider.CLICK]),
});

/** A manual top-up request: what the pro says they transferred, and from where. */
const topUpRequestSchema = z.object({
  amount: z.coerce
    .number()
    .int()
    .min(walletService.MIN_TOP_UP)
    .max(walletService.MAX_TOP_UP),
  payerNote: z.string().trim().min(3).max(200),
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
      req.body as { amount: number; provider: CheckoutProvider },
    );
    ok(res, result);
  }),
);

walletRouter.post(
  '/top-up-requests',
  authenticate,
  authorize(UserRole.MASTER, UserRole.SELLER),
  topUpRequestLimiter,
  validate({ body: topUpRequestSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const result = await walletService.createTopUpRequest(
      req.user.id,
      req.body as walletService.TopUpRequestInput,
    );
    created(res, result);
  }),
);

/**
 * Provider callbacks. These are unauthenticated by nature — the provider has no
 * user token — so each one is verified by its own signature scheme before any
 * money moves.
 */
walletRouter.post(
  '/callback/click',
  webhookLimiter,
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
    res.json(await walletService.handleClickCallback(body));
  }),
);

/**
 * Payme's Merchant API is a single JSON-RPC endpoint; the handler owns its own
 * error envelope, so it is mounted directly rather than through `asyncHandler`.
 */
walletRouter.post('/callback/payme', webhookLimiter, (req, res, next) => {
  void paymeCallback(req, res).catch(next);
});
