import { Router } from 'express';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { validate } from '../../common/middlewares/validate.middleware';
import { topUpRequestLimiter, webhookLimiter } from '../../common/middlewares/rateLimit.middleware';
import { UserRole } from '../../common/types';
import * as controller from './wallet.controller';
import { topUpRequestSchema, topUpSchema, transactionsQuerySchema } from './wallet.validator';

export const walletRouter = Router();

walletRouter.get('/', authenticate, controller.balance);

walletRouter.get(
  '/transactions',
  authenticate,
  validate({ query: transactionsQuerySchema }),
  controller.transactions,
);

walletRouter.post(
  '/top-up',
  authenticate,
  authorize(UserRole.MASTER, UserRole.SELLER),
  validate({ body: topUpSchema }),
  controller.startTopUp,
);

walletRouter.post(
  '/top-up-requests',
  authenticate,
  authorize(UserRole.MASTER, UserRole.SELLER),
  topUpRequestLimiter,
  validate({ body: topUpRequestSchema }),
  controller.createTopUpRequest,
);

/**
 * Provider callbacks. These are unauthenticated by nature — the provider has no
 * user token — so each one is verified by its own signature scheme before any
 * money moves.
 */
walletRouter.post('/callback/click', webhookLimiter, controller.clickCallback);
walletRouter.post('/callback/payme', webhookLimiter, controller.paymeWebhook);
