import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/middlewares/auth.middleware';
import {
  idParamSchema,
  paginationSchema,
  validate,
} from '../../common/middlewares/validate.middleware';
import { asyncHandler, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import * as notificationService from './notification.service';

const deviceSchema = z.object({ token: z.string().trim().min(10).max(500) });

export const notificationRouter = Router();

notificationRouter.use(authenticate);

notificationRouter.get(
  '/',
  validate({ query: paginationSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    ok(res, await notificationService.listForUser(req.user.id, page, limit));
  }),
);

notificationRouter.get(
  '/unread',
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    ok(res, { total: await notificationService.unreadCount(req.user.id) });
  }),
);

notificationRouter.post(
  '/read-all',
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    await notificationService.markAllRead(req.user.id);
    ok(res, { read: true });
  }),
);

notificationRouter.post(
  '/:id/read',
  validate({ params: idParamSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    await notificationService.markRead(req.user.id, req.params.id as string);
    ok(res, { read: true });
  }),
);

notificationRouter.post(
  '/devices',
  validate({ body: deviceSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    await notificationService.registerDevice(req.user.id, (req.body as { token: string }).token);
    ok(res, { registered: true });
  }),
);

notificationRouter.delete(
  '/devices',
  validate({ body: deviceSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    await notificationService.unregisterDevice(req.user.id, (req.body as { token: string }).token);
    ok(res, { unregistered: true });
  }),
);
