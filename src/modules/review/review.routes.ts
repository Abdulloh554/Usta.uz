import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import {
  objectIdSchema,
  paginationSchema,
  validate,
} from '../../common/middlewares/validate.middleware';
import { asyncHandler, created, ok } from '../../common/utils/http';
import { UserRole, type AuthenticatedRequest } from '../../common/types';
import * as reviewService from './review.service';

const stars = z.coerce.number().int().min(1, 'Rate from 1 to 5').max(5, 'Rate from 1 to 5');
const comment = z.string().trim().max(1000).optional();

const rateMasterSchema = z.object({ orderId: objectIdSchema, stars, comment });
const rateProductSchema = z.object({ productId: objectIdSchema, stars, comment });
const idParam = z.object({ id: objectIdSchema });

export const reviewRouter = Router();

reviewRouter.get(
  '/master/:id',
  validate({ params: idParam, query: paginationSchema }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    ok(res, await reviewService.listForMaster(req.params.id as string, page, limit));
  }),
);

reviewRouter.get(
  '/product/:id',
  validate({ params: idParam, query: paginationSchema }),
  asyncHandler(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    ok(res, await reviewService.listForProduct(req.params.id as string, page, limit));
  }),
);

reviewRouter.post(
  '/master',
  authenticate,
  authorize(UserRole.CLIENT),
  validate({ body: rateMasterSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const review = await reviewService.rateMaster(
      req.user.id,
      req.body as { orderId: string; stars: number; comment?: string },
    );
    created(res, review);
  }),
);

reviewRouter.post(
  '/product',
  authenticate,
  validate({ body: rateProductSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const review = await reviewService.rateProduct(
      req.user.id,
      req.body as { productId: string; stars: number; comment?: string },
    );
    created(res, review);
  }),
);

reviewRouter.post(
  '/:id/hide',
  authenticate,
  authorize(UserRole.ADMIN),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await reviewService.hideReview(req.params.id as string);
    ok(res, { hidden: true });
  }),
);
