import { Router } from 'express';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { validate } from '../../common/middlewares/validate.middleware';
import { orderCreateLimiter } from '../../common/middlewares/rateLimit.middleware';
import { UserRole } from '../../common/types';
import * as controller from './order.controller';
import {
  cancelOrderSchema,
  createOrderSchema,
  feedSchema,
  listOrdersSchema,
  orderIdParamSchema,
} from './order.validator';

export const orderRouter = Router();

orderRouter.use(authenticate);

/* — pro-only routes, declared before `/:id` so `feed` is not read as an id — */
orderRouter.get(
  '/feed',
  authorize(UserRole.MASTER),
  validate({ query: feedSchema }),
  controller.feed,
);
orderRouter.get('/offer', authorize(UserRole.MASTER), controller.outstandingOffer);

orderRouter.post(
  '/',
  authorize(UserRole.CLIENT),
  orderCreateLimiter,
  validate({ body: createOrderSchema }),
  controller.create,
);

orderRouter.get('/', validate({ query: listOrdersSchema }), controller.list);
orderRouter.get('/counts', authorize(UserRole.CLIENT), controller.counts);

orderRouter.get('/:id', validate({ params: orderIdParamSchema }), controller.detail);

orderRouter.post(
  '/:id/accept',
  authorize(UserRole.MASTER),
  validate({ params: orderIdParamSchema }),
  controller.accept,
);
orderRouter.post(
  '/:id/pass',
  authorize(UserRole.MASTER),
  validate({ params: orderIdParamSchema }),
  controller.pass,
);
orderRouter.post(
  '/:id/complete',
  authorize(UserRole.MASTER),
  validate({ params: orderIdParamSchema }),
  controller.complete,
);

orderRouter.post(
  '/:id/cancel',
  validate({ params: orderIdParamSchema, body: cancelOrderSchema }),
  controller.cancel,
);
