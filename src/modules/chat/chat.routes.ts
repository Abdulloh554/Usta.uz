import { Router } from 'express';
import { authenticate } from '../../common/middlewares/auth.middleware';
import { validate } from '../../common/middlewares/validate.middleware';
import * as controller from './chat.controller';
import {
  chatIdParamSchema,
  listMessagesSchema,
  orderIdParamSchema,
  sendMessageSchema,
} from './chat.validator';

export const chatRouter = Router();

chatRouter.use(authenticate);

chatRouter.get('/', controller.list);
chatRouter.get('/unread', controller.unread);
chatRouter.get('/by-order/:orderId', validate({ params: orderIdParamSchema }), controller.byOrder);

chatRouter.get('/:id', validate({ params: chatIdParamSchema }), controller.detail);
chatRouter.get(
  '/:id/messages',
  validate({ params: chatIdParamSchema, query: listMessagesSchema }),
  controller.messages,
);
chatRouter.post(
  '/:id/messages',
  validate({ params: chatIdParamSchema, body: sendMessageSchema }),
  controller.send,
);
chatRouter.post('/:id/read', validate({ params: chatIdParamSchema }), controller.read);
