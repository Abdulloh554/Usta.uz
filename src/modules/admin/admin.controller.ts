import type { Request, RequestHandler } from 'express';
import { asyncHandler, noContent, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import * as adminService from './admin.service';
import * as statsService from './stats.service';
import * as paymentsService from './payments.service';
import { getBroadcast } from './broadcast.service';
import { askAssistant, assistantStatus } from './assistant.service';
import type {
  AdjustBalanceInput,
  AdminCancelOrderInput,
  ApprovePaymentInput,
  AssistantInput,
  BroadcastInput,
  ListChatsInput,
  ListLogsInput,
  ListOrdersInput,
  ListPaymentsInput,
  ListProductsInput,
  ListReviewsInput,
  ListTransactionsInput,
  ListUsersInput,
  MessagesQuery,
  RejectPaymentInput,
  ResetPasswordInput,
  TimeseriesQuery,
  UpdateChatInput,
  UpdateProductInput,
  UpdateReviewInput,
  UpdateUserStatusInput,
} from './admin.validator';

/** Every admin route sits behind `authorize(ADMIN)`, so the user is always set. */
type AdminRequest = AuthenticatedRequest;

const id = (req: Request): string => req.params.id as string;
const query = <T>(req: Request): T => req.query as unknown as T;

/* — assistant — */

export const assistantInfo: RequestHandler = (_req, res) => {
  ok(res, assistantStatus());
};

export const ask = asyncHandler(async (req, res) => {
  ok(res, await askAssistant(req.body as AssistantInput));
});

/* — analytics — */

export const overview = asyncHandler(async (_req, res) => {
  ok(res, await statsService.overview());
});

export const timeseries = asyncHandler(async (req, res) => {
  ok(res, await statsService.timeseries(query<TimeseriesQuery>(req).days));
});

export const topMasters = asyncHandler(async (_req, res) => {
  ok(res, await statsService.topMasters(10));
});

export const system: RequestHandler = (_req, res) => {
  ok(res, statsService.systemInfo());
};

/* — users — */

export const listUsers = asyncHandler(async (req, res) => {
  ok(res, await adminService.listUsers(query<ListUsersInput>(req)));
});

export const getUser = asyncHandler(async (req, res) => {
  ok(res, await adminService.getUser(id(req)));
});

export const updateUserStatus = asyncHandler<AdminRequest>(async (req, res) => {
  ok(
    res,
    await adminService.updateUserStatus(req.user.id, id(req), req.body as UpdateUserStatusInput),
  );
});

export const adjustBalance = asyncHandler<AdminRequest>(async (req, res) => {
  ok(res, await adminService.adjustBalance(req.user.id, id(req), req.body as AdjustBalanceInput));
});

export const revokeSessions = asyncHandler<AdminRequest>(async (req, res) => {
  await adminService.revokeSessions(req.user.id, id(req));
  ok(res, { revoked: true });
});

export const resetPassword = asyncHandler<AdminRequest>(async (req, res) => {
  await adminService.resetPassword(req.user.id, id(req), req.body as ResetPasswordInput);
  ok(res, { reset: true });
});

/* — jobs ("e'lonlar") — */

export const listOrders = asyncHandler(async (req, res) => {
  ok(res, await adminService.listOrders(query<ListOrdersInput>(req)));
});

export const getOrder = asyncHandler(async (req, res) => {
  ok(res, await adminService.getOrder(id(req)));
});

export const cancelOrder = asyncHandler<AdminRequest>(async (req, res) => {
  ok(res, await adminService.cancelOrder(req.user.id, id(req), req.body as AdminCancelOrderInput));
});

/* — chats — */

export const listChats = asyncHandler(async (req, res) => {
  ok(res, await adminService.listChats(query<ListChatsInput>(req)));
});

export const getChat = asyncHandler(async (req, res) => {
  ok(res, await adminService.getChat(id(req)));
});

export const listMessages = asyncHandler(async (req, res) => {
  const { page, limit } = query<MessagesQuery>(req);
  ok(res, await adminService.listMessages(id(req), page, limit));
});

export const updateChat = asyncHandler<AdminRequest>(async (req, res) => {
  const { isClosed } = req.body as UpdateChatInput;
  ok(res, await adminService.setChatClosed(req.user.id, id(req), isClosed));
});

export const deleteMessage = asyncHandler<AdminRequest>(async (req, res) => {
  await adminService.deleteMessage(req.user.id, id(req));
  noContent(res);
});

/* — products — */

export const listProducts = asyncHandler(async (req, res) => {
  ok(res, await adminService.listProducts(query<ListProductsInput>(req)));
});

export const updateProduct = asyncHandler<AdminRequest>(async (req, res) => {
  const { isActive } = req.body as UpdateProductInput;
  ok(res, await adminService.setProductActive(req.user.id, id(req), isActive));
});

/* — reviews — */

export const listReviews = asyncHandler(async (req, res) => {
  ok(res, await adminService.listReviews(query<ListReviewsInput>(req)));
});

export const updateReview = asyncHandler<AdminRequest>(async (req, res) => {
  const { isVisible } = req.body as UpdateReviewInput;
  ok(res, await adminService.setReviewVisible(req.user.id, id(req), isVisible));
});

/* — money — */

export const listTransactions = asyncHandler(async (req, res) => {
  ok(res, await adminService.listTransactions(query<ListTransactionsInput>(req)));
});

/* — manual top-ups ("To'lovlar") — */

export const listPayments = asyncHandler(async (req, res) => {
  ok(res, await paymentsService.listPayments(query<ListPaymentsInput>(req)));
});

export const pendingPayments = asyncHandler(async (_req, res) => {
  ok(res, await paymentsService.pendingCount());
});

export const approvePayment = asyncHandler<AdminRequest>(async (req, res) => {
  ok(
    res,
    await paymentsService.approvePayment(req.user.id, id(req), req.body as ApprovePaymentInput),
  );
});

export const rejectPayment = asyncHandler<AdminRequest>(async (req, res) => {
  ok(
    res,
    await paymentsService.rejectPayment(req.user.id, id(req), req.body as RejectPaymentInput),
  );
});

/* — broadcasts and the journal — */

export const getBroadcastById = asyncHandler(async (req, res) => {
  ok(res, await getBroadcast(id(req)));
});

export const broadcast = asyncHandler<AdminRequest>(async (req, res) => {
  ok(res, await adminService.broadcast(req.user.id, req.body as BroadcastInput));
});

export const listLogs = asyncHandler(async (req, res) => {
  ok(res, await adminService.listLogs(query<ListLogsInput>(req)));
});
