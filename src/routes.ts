import { Router } from 'express';
import { authRouter } from './modules/auth/auth.routes';
import { userRouter } from './modules/user/user.routes';
import { orderRouter } from './modules/order/order.routes';
import { chatRouter } from './modules/chat/chat.routes';
import { productRouter } from './modules/product/product.routes';
import { reviewRouter } from './modules/review/review.routes';
import { walletRouter } from './modules/wallet/wallet.routes';
import { notificationRouter } from './modules/notification/notification.routes';
import { mediaRouter } from './modules/media/media.routes';
import { adminRouter } from './modules/admin/admin.routes';

/** Every module mounts here; `app.ts` mounts this once under the API prefix. */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/orders', orderRouter);
apiRouter.use('/chats', chatRouter);
apiRouter.use('/products', productRouter);
apiRouter.use('/reviews', reviewRouter);
apiRouter.use('/wallet', walletRouter);
apiRouter.use('/notifications', notificationRouter);
apiRouter.use('/media', mediaRouter);
apiRouter.use('/admin', adminRouter);
