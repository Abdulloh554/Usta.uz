import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { idParamSchema, validate } from '../../common/middlewares/validate.middleware';
import { asyncHandler, ok } from '../../common/utils/http';
import { Craft, Language, UserRole, type AuthenticatedRequest } from '../../common/types';
import * as userService from './user.service';

const updateProfileSchema = z.object({
  firstName: z.string().trim().min(2).max(50).optional(),
  lastName: z.string().trim().min(2).max(50).optional(),
  language: z.nativeEnum(Language).optional(),
  avatarUrl: z.string().url().optional(),
});

const updateMasterSchema = z.object({
  crafts: z.array(z.nativeEnum(Craft)).min(1).max(12).optional(),
  about: z.string().trim().max(1000).optional(),
  regions: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  location: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
  isAvailable: z.boolean().optional(),
});

const topMastersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
  craft: z.nativeEnum(Craft).optional(),
});

export const userRouter = Router();

userRouter.get(
  '/top-masters',
  validate({ query: topMastersSchema }),
  asyncHandler(async (req, res) => {
    const { limit, craft } = req.query as unknown as { limit: number; craft?: Craft };
    ok(res, await userService.topMasters(limit, craft));
  }),
);

userRouter.patch(
  '/me',
  authenticate,
  validate({ body: updateProfileSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    ok(res, await userService.updateProfile(req.user.id, req.body as userService.UpdateProfileInput));
  }),
);

userRouter.patch(
  '/me/master',
  authenticate,
  authorize(UserRole.MASTER),
  validate({ body: updateMasterSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    ok(
      res,
      await userService.updateMasterProfile(
        req.user.id,
        req.body as userService.UpdateMasterProfileInput,
      ),
    );
  }),
);

userRouter.get(
  '/me/history',
  authenticate,
  authorize(UserRole.MASTER),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    ok(res, await userService.workHistory(req.user.id));
  }),
);

userRouter.get(
  '/masters/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await userService.getMasterProfile(req.params.id as string));
  }),
);

userRouter.get(
  '/masters/:id/history',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await userService.workHistory(req.params.id as string));
  }),
);
