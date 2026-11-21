import type { RequestHandler } from 'express';
import { asyncHandler, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import { env } from '../../config/env';
import * as notificationService from './notification.service';
import type { DeviceInput, NotificationListQuery } from './notification.validator';

export const list = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { page, limit } = req.query as unknown as NotificationListQuery;
  ok(res, await notificationService.listForUser(req.user.id, page, limit));
});

/** The VAPID public key the web app subscribes with; `null` while browser push is off. */
export const webPushKey: RequestHandler = (_req, res) => {
  const enabled = Boolean(env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY);
  ok(res, { publicKey: enabled ? env.WEB_PUSH_PUBLIC_KEY : null });
};

export const unread = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, { total: await notificationService.unreadCount(req.user.id) });
});

export const readAll = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  await notificationService.markAllRead(req.user.id);
  ok(res, { read: true });
});

export const read = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  await notificationService.markRead(req.user.id, req.params.id as string);
  ok(res, { read: true });
});

export const registerDevice = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  await notificationService.registerDevice(req.user.id, (req.body as DeviceInput).token);
  ok(res, { registered: true });
});

export const unregisterDevice = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  await notificationService.unregisterDevice(req.user.id, (req.body as DeviceInput).token);
  ok(res, { unregistered: true });
});
