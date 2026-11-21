import { Router } from 'express';
import { authenticate } from '../../common/middlewares/auth.middleware';
import { idParamSchema, validate } from '../../common/middlewares/validate.middleware';
import * as controller from './notification.controller';
import { deviceSchema, notificationListQuerySchema } from './notification.validator';

export const notificationRouter = Router();

notificationRouter.use(authenticate);

notificationRouter.get('/', validate({ query: notificationListQuerySchema }), controller.list);
notificationRouter.get('/web-push/key', controller.webPushKey);
notificationRouter.get('/unread', controller.unread);
notificationRouter.post('/read-all', controller.readAll);
notificationRouter.post('/:id/read', validate({ params: idParamSchema }), controller.read);

notificationRouter.post('/devices', validate({ body: deviceSchema }), controller.registerDevice);
notificationRouter.delete(
  '/devices',
  validate({ body: deviceSchema }),
  controller.unregisterDevice,
);
