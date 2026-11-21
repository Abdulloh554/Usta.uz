import { Router } from 'express';
import {
  authenticate,
  authorize,
  optionalAuthenticate,
} from '../../common/middlewares/auth.middleware';
import { idParamSchema, validate } from '../../common/middlewares/validate.middleware';
import { UserRole } from '../../common/types';
import * as controller from './product.controller';
import {
  listProductsSchema,
  productBodySchema,
  productUpdateSchema,
  purchaseListSchema,
  purchaseSchema,
  purchaseStatusSchema,
} from './product.validator';

export const productRouter = Router();

/* — purchases — */
productRouter.get(
  '/purchases',
  authenticate,
  authorize(UserRole.CLIENT, UserRole.MASTER, UserRole.SELLER),
  validate({ query: purchaseListSchema }),
  controller.listPurchases,
);
productRouter.post(
  '/:id/purchase',
  authenticate,
  authorize(UserRole.CLIENT, UserRole.MASTER),
  validate({ params: idParamSchema, body: purchaseSchema }),
  controller.createPurchase,
);
productRouter.patch(
  '/purchases/:id',
  authenticate,
  authorize(UserRole.CLIENT, UserRole.MASTER, UserRole.SELLER),
  validate({ params: idParamSchema, body: purchaseStatusSchema }),
  controller.updatePurchase,
);

/* — seller-owned and personal routes, before `/:id` so they are not read as ids — */
productRouter.get('/mine', authenticate, authorize(UserRole.SELLER), controller.mine);
productRouter.get('/favorites', authenticate, controller.favorites);

/* — catalogue — */
productRouter.get(
  '/',
  optionalAuthenticate,
  validate({ query: listProductsSchema }),
  controller.list,
);
productRouter.get('/:id', validate({ params: idParamSchema }), controller.detail);

productRouter.post(
  '/',
  authenticate,
  authorize(UserRole.SELLER),
  validate({ body: productBodySchema }),
  controller.create,
);
productRouter.patch(
  '/:id',
  authenticate,
  authorize(UserRole.SELLER),
  validate({ params: idParamSchema, body: productUpdateSchema }),
  controller.update,
);
productRouter.delete(
  '/:id',
  authenticate,
  authorize(UserRole.SELLER),
  validate({ params: idParamSchema }),
  controller.remove,
);

productRouter.post(
  '/:id/favorite',
  authenticate,
  validate({ params: idParamSchema }),
  controller.toggleFavorite,
);
