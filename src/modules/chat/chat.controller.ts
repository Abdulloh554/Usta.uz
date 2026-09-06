import { asyncHandler, created, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import * as chatService from './chat.service';
import type { SendMessageBody } from './chat.validator';

export const list = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await chatService.listChats(req.user.id));
});

export const detail = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await chatService.getChat(req.params.id as string, req.user.id));
});

export const byOrder = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await chatService.getChatByOrder(req.params.orderId as string, req.user.id));
});

export const messages = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };
  ok(res, await chatService.listMessages(req.params.id as string, req.user.id, page, limit));
});

export const send = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const message = await chatService.sendMessage(
    req.params.id as string,
    req.user.id,
    req.body as SendMessageBody,
  );
  created(res, message);
});

export const read = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  await chatService.markRead(req.params.id as string, req.user.id);
  ok(res, { read: true });
});

export const unread = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, { total: await chatService.unreadTotal(req.user.id) });
});
