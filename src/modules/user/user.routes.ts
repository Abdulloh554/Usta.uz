import { Router } from 'express';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { idParamSchema, validate } from '../../common/middlewares/validate.middleware';
import { UserRole } from '../../common/types';
import * as controller from './user.controller';
import {
  deleteAccountSchema,
  topMastersSchema,
  updateMasterSchema,
  updateProfileSchema,
} from './user.validator';

export const userRouter = Router();

userRouter.get('/top-masters', validate({ query: topMastersSchema }), controller.topMasters);

userRouter.patch(
  '/me',
  authenticate,
  validate({ body: updateProfileSchema }),
  controller.updateProfile,
);

userRouter.patch(
  '/me/master',
  authenticate,
  authorize(UserRole.MASTER),
  validate({ body: updateMasterSchema }),
  controller.updateMasterProfile,
);

/**
 * Google Play requires an in-app route to account deletion for any app that
 * lets people create one. The password (or mailed code) re-check is what stops
 * a borrowed, unlocked phone from wiping someone's account.
 */
userRouter.delete(
  '/me',
  authenticate,
  validate({ body: deleteAccountSchema }),
  controller.deleteAccount,
);

userRouter.get('/me/history', authenticate, authorize(UserRole.MASTER), controller.myHistory);

userRouter.get('/masters/:id', validate({ params: idParamSchema }), controller.masterProfile);

userRouter.get(
  '/masters/:id/history',
  validate({ params: idParamSchema }),
  controller.masterHistory,
);
