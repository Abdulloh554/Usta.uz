import { Router } from 'express';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { idParamSchema, validate } from '../../common/middlewares/validate.middleware';
import { UserRole } from '../../common/types';
import * as controller from './review.controller';
import { rateMasterSchema, rateProductSchema, reviewListQuerySchema } from './review.validator';

export const reviewRouter = Router();

reviewRouter.get(
  '/master/:id',
  validate({ params: idParamSchema, query: reviewListQuerySchema }),
  controller.listForMaster,
);
reviewRouter.get(
  '/product/:id',
  validate({ params: idParamSchema, query: reviewListQuerySchema }),
  controller.listForProduct,
);

reviewRouter.post(
  '/master',
  authenticate,
  authorize(UserRole.CLIENT),
  validate({ body: rateMasterSchema }),
  controller.rateMaster,
);
reviewRouter.post(
  '/product',
  authenticate,
  validate({ body: rateProductSchema }),
  controller.rateProduct,
);

reviewRouter.post(
  '/:id/hide',
  authenticate,
  authorize(UserRole.ADMIN),
  validate({ params: idParamSchema }),
  controller.hide,
);
