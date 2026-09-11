import { Router } from 'express';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { idParamSchema, validate } from '../../common/middlewares/validate.middleware';
import { asyncHandler, noContent, ok } from '../../common/utils/http';
import { UserRole, type AuthenticatedRequest } from '../../common/types';
import * as adminService from './admin.service';
import * as statsService from './stats.service';
import {
  adjustBalanceSchema,
  adminCancelOrderSchema,
  broadcastSchema,
  listChatsSchema,
  listLogsSchema,
  listOrdersSchema,
  listProductsSchema,
  listReviewsSchema,
  listTransactionsSchema,
  listUsersSchema,
  messagesSchema,
  timeseriesSchema,
  updateChatSchema,
  updateProductSchema,
  updateReviewSchema,
  updateUserStatusSchema,
  type AdjustBalanceInput,
  type AdminCancelOrderInput,
  type BroadcastInput,
  type ListChatsInput,
  type ListLogsInput,
  type ListOrdersInput,
  type ListProductsInput,
  type ListReviewsInput,
  type ListTransactionsInput,
  type ListUsersInput,
  type UpdateUserStatusInput,
} from './admin.validator';

type AdminRequest = AuthenticatedRequest;

const id = (req: AdminRequest): string => req.params.id as string;

/**
 * Everything under `/admin` requires an admin token. The role check sits on the
 * router itself, so a route added later cannot forget it.
 */
export const adminRouter = Router();

adminRouter.use(authenticate, authorize(UserRole.ADMIN));

/* — analytics — */
adminRouter.get(
  '/stats/overview',
  asyncHandler(async (_req, res) => {
    ok(res, await statsService.overview());
  }),
);

adminRouter.get(
  '/stats/timeseries',
  validate({ query: timeseriesSchema }),
  asyncHandler(async (req, res) => {
    const { days } = req.query as unknown as { days: number };
    ok(res, await statsService.timeseries(days));
  }),
);

adminRouter.get(
  '/stats/top-masters',
  asyncHandler(async (_req, res) => {
    ok(res, await statsService.topMasters(10));
  }),
);

adminRouter.get('/system', (_req, res) => {
  ok(res, statsService.systemInfo());
});

/* — users — */
adminRouter.get(
  '/users',
  validate({ query: listUsersSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await adminService.listUsers(req.query as unknown as ListUsersInput));
  }),
);

adminRouter.get(
  '/users/:id',
  validate({ params: idParamSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    ok(res, await adminService.getUser(id(req)));
  }),
);

adminRouter.patch(
  '/users/:id/status',
  validate({ params: idParamSchema, body: updateUserStatusSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    ok(
      res,
      await adminService.updateUserStatus(req.user.id, id(req), req.body as UpdateUserStatusInput),
    );
  }),
);

adminRouter.post(
  '/users/:id/balance',
  validate({ params: idParamSchema, body: adjustBalanceSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    ok(res, await adminService.adjustBalance(req.user.id, id(req), req.body as AdjustBalanceInput));
  }),
);

adminRouter.post(
  '/users/:id/revoke-sessions',
  validate({ params: idParamSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    await adminService.revokeSessions(req.user.id, id(req));
    ok(res, { revoked: true });
  }),
);

/* — jobs ("e'lonlar") — */
adminRouter.get(
  '/orders',
  validate({ query: listOrdersSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await adminService.listOrders(req.query as unknown as ListOrdersInput));
  }),
);

adminRouter.get(
  '/orders/:id',
  validate({ params: idParamSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    ok(res, await adminService.getOrder(id(req)));
  }),
);

adminRouter.post(
  '/orders/:id/cancel',
  validate({ params: idParamSchema, body: adminCancelOrderSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    ok(res, await adminService.cancelOrder(req.user.id, id(req), req.body as AdminCancelOrderInput));
  }),
);

/* — chats — */
adminRouter.get(
  '/chats',
  validate({ query: listChatsSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await adminService.listChats(req.query as unknown as ListChatsInput));
  }),
);

adminRouter.get(
  '/chats/:id',
  validate({ params: idParamSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    ok(res, await adminService.getChat(id(req)));
  }),
);

adminRouter.get(
  '/chats/:id/messages',
  validate({ params: idParamSchema, query: messagesSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { page, limit } = req.query as unknown as { page: number; limit: number };
    ok(res, await adminService.listMessages(id(req), page, limit));
  }),
);

adminRouter.patch(
  '/chats/:id',
  validate({ params: idParamSchema, body: updateChatSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { isClosed } = req.body as { isClosed: boolean };
    ok(res, await adminService.setChatClosed(req.user.id, id(req), isClosed));
  }),
);

adminRouter.delete(
  '/messages/:id',
  validate({ params: idParamSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    await adminService.deleteMessage(req.user.id, id(req));
    noContent(res);
  }),
);

/* — products — */
adminRouter.get(
  '/products',
  validate({ query: listProductsSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await adminService.listProducts(req.query as unknown as ListProductsInput));
  }),
);

adminRouter.patch(
  '/products/:id',
  validate({ params: idParamSchema, body: updateProductSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { isActive } = req.body as { isActive: boolean };
    ok(res, await adminService.setProductActive(req.user.id, id(req), isActive));
  }),
);

/* — reviews — */
adminRouter.get(
  '/reviews',
  validate({ query: listReviewsSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await adminService.listReviews(req.query as unknown as ListReviewsInput));
  }),
);

adminRouter.patch(
  '/reviews/:id',
  validate({ params: idParamSchema, body: updateReviewSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    const { isVisible } = req.body as { isVisible: boolean };
    ok(res, await adminService.setReviewVisible(req.user.id, id(req), isVisible));
  }),
);

/* — money — */
adminRouter.get(
  '/transactions',
  validate({ query: listTransactionsSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await adminService.listTransactions(req.query as unknown as ListTransactionsInput));
  }),
);

/* — broadcasts and the journal — */
adminRouter.post(
  '/broadcasts',
  validate({ body: broadcastSchema }),
  asyncHandler<AdminRequest>(async (req, res) => {
    ok(res, await adminService.broadcast(req.user.id, req.body as BroadcastInput));
  }),
);

adminRouter.get(
  '/logs',
  validate({ query: listLogsSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await adminService.listLogs(req.query as unknown as ListLogsInput));
  }),
);
