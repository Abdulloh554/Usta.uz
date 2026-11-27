import { Router } from 'express';
import { authenticate, authorize } from '../../common/middlewares/auth.middleware';
import { idParamSchema, validate } from '../../common/middlewares/validate.middleware';
import { assistantLimiter } from '../../common/middlewares/rateLimit.middleware';
import { UserRole } from '../../common/types';
import * as traffic from '../traffic/traffic.controller';
import { trafficQuerySchema } from '../traffic/traffic.validator';
import * as controller from './admin.controller';
import {
  adjustBalanceSchema,
  adminCancelOrderSchema,
  approvePaymentSchema,
  assistantSchema,
  broadcastSchema,
  deleteUserSchema,
  listChatsSchema,
  listLogsSchema,
  listOrdersSchema,
  listPaymentsSchema,
  listProductsSchema,
  listReviewsSchema,
  listTransactionsSchema,
  listUsersSchema,
  messagesSchema,
  rejectPaymentSchema,
  resetPasswordSchema,
  timeseriesSchema,
  updateChatSchema,
  updateProductSchema,
  updateReviewSchema,
  updateUserStatusSchema,
} from './admin.validator';

const byId = validate({ params: idParamSchema });

/**
 * Everything under `/admin` requires an admin token. The role check sits on the
 * router itself, so a route added later cannot forget it.
 */
export const adminRouter = Router();

adminRouter.use(authenticate, authorize(UserRole.ADMIN));

/* — assistant — */
adminRouter.get('/assistant/status', controller.assistantInfo);
adminRouter.post(
  '/assistant',
  assistantLimiter,
  validate({ body: assistantSchema }),
  controller.ask,
);

/* — analytics — */
adminRouter.get('/stats/traffic', validate({ query: trafficQuerySchema }), traffic.report);
adminRouter.get('/stats/overview', controller.overview);
adminRouter.get('/stats/timeseries', validate({ query: timeseriesSchema }), controller.timeseries);
adminRouter.get('/stats/top-masters', controller.topMasters);
adminRouter.get('/system', controller.system);

/* — users — */
adminRouter.get('/users', validate({ query: listUsersSchema }), controller.listUsers);
adminRouter.get('/users/:id', byId, controller.getUser);
adminRouter.patch(
  '/users/:id/status',
  validate({ params: idParamSchema, body: updateUserStatusSchema }),
  controller.updateUserStatus,
);
adminRouter.post(
  '/users/:id/balance',
  validate({ params: idParamSchema, body: adjustBalanceSchema }),
  controller.adjustBalance,
);
adminRouter.post('/users/:id/revoke-sessions', byId, controller.revokeSessions);
adminRouter.post(
  '/users/:id/password',
  validate({ params: idParamSchema, body: resetPasswordSchema }),
  controller.resetPassword,
);
// POST rather than DELETE: the request carries a reason, and a body on DELETE is
// something proxies are allowed to drop.
adminRouter.post(
  '/users/:id/delete',
  validate({ params: idParamSchema, body: deleteUserSchema }),
  controller.deleteUser,
);

/* — jobs ("e'lonlar") — */
adminRouter.get('/orders', validate({ query: listOrdersSchema }), controller.listOrders);
adminRouter.get('/orders/:id', byId, controller.getOrder);
adminRouter.post(
  '/orders/:id/cancel',
  validate({ params: idParamSchema, body: adminCancelOrderSchema }),
  controller.cancelOrder,
);

/* — chats — */
adminRouter.get('/chats', validate({ query: listChatsSchema }), controller.listChats);
adminRouter.get('/chats/:id', byId, controller.getChat);
adminRouter.get(
  '/chats/:id/messages',
  validate({ params: idParamSchema, query: messagesSchema }),
  controller.listMessages,
);
adminRouter.patch(
  '/chats/:id',
  validate({ params: idParamSchema, body: updateChatSchema }),
  controller.updateChat,
);
adminRouter.delete('/messages/:id', byId, controller.deleteMessage);

/* — products — */
adminRouter.get('/products', validate({ query: listProductsSchema }), controller.listProducts);
adminRouter.patch(
  '/products/:id',
  validate({ params: idParamSchema, body: updateProductSchema }),
  controller.updateProduct,
);

/* — reviews — */
adminRouter.get('/reviews', validate({ query: listReviewsSchema }), controller.listReviews);
adminRouter.patch(
  '/reviews/:id',
  validate({ params: idParamSchema, body: updateReviewSchema }),
  controller.updateReview,
);

/* — money — */
adminRouter.get(
  '/transactions',
  validate({ query: listTransactionsSchema }),
  controller.listTransactions,
);

/* — manual top-ups ("To'lovlar") — */
adminRouter.get('/payments', validate({ query: listPaymentsSchema }), controller.listPayments);
adminRouter.get('/payments/pending-count', controller.pendingPayments);
adminRouter.post(
  '/payments/:id/approve',
  validate({ params: idParamSchema, body: approvePaymentSchema }),
  controller.approvePayment,
);
adminRouter.post(
  '/payments/:id/reject',
  validate({ params: idParamSchema, body: rejectPaymentSchema }),
  controller.rejectPayment,
);

/* — broadcasts and the journal — */
adminRouter.get('/broadcasts/:id', byId, controller.getBroadcastById);
adminRouter.post('/broadcasts', validate({ body: broadcastSchema }), controller.broadcast);
adminRouter.get('/logs', validate({ query: listLogsSchema }), controller.listLogs);
