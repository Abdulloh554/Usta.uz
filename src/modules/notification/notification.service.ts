import mongoose from 'mongoose';
import { logger } from '../../config/logger';
import { NotFoundError } from '../../common/errors/ApiError';
// `NotificationType` is a merged const + type: it is imported as a value
// because the copy table below is keyed by its members.
import { NotificationType, type Language, type Paginated } from '../../common/types';
import { paginate } from '../../common/utils/http';
import { emitToUser } from '../../sockets/emitter';
import { SocketEvent } from '../../sockets/events';
import { User } from '../user/user.model';
import { getNotificationQueue, NotificationJob } from '../../jobs/queues';
import { isQueueCapable } from '../../jobs/scheduler';
import { pushProvider } from '../../config/push';
import { Notification, type NotificationDocument } from './notification.model';

/** Copy for every notification, in the three languages the app ships. */
const COPY: Record<NotificationType, Record<Language, { title: string; body: string }>> = {
  [NotificationType.ORDER_OFFER]: {
    uz: { title: 'Yangi elon', body: 'Sizga mos yangi elon keldi — javob bering.' },
    ru: { title: 'Новая заявка', body: 'Для вас есть новая заявка — ответьте.' },
    en: { title: 'New job', body: 'A job matching your trade is waiting for your answer.' },
  },
  [NotificationType.ORDER_ACCEPTED]: {
    uz: { title: 'Usta topildi', body: 'Ustangiz elonni qabul qildi.' },
    ru: { title: 'Мастер найден', body: 'Мастер принял вашу заявку.' },
    en: { title: 'A pro took your job', body: 'Your job has been accepted.' },
  },
  [NotificationType.ORDER_CANCELLED]: {
    uz: { title: 'Elon bekor qilindi', body: 'Elon bekor qilindi — sababi elonda ko‘rinadi.' },
    ru: { title: 'Заявка отменена', body: 'Заявка отменена — причина указана в заявке.' },
    en: { title: 'Job cancelled', body: 'The job was cancelled — the reason is on the job.' },
  },
  [NotificationType.ORDER_COMPLETED]: {
    uz: { title: 'Ish yakunlandi', body: 'Ish yakunlandi — ustani baholang.' },
    ru: { title: 'Работа завершена', body: 'Работа завершена — оцените мастера.' },
    en: { title: 'Work complete', body: 'The work is done — please rate the pro.' },
  },
  [NotificationType.NEW_MESSAGE]: {
    uz: { title: 'Yangi xabar', body: 'Sizga yangi xabar keldi.' },
    ru: { title: 'Новое сообщение', body: 'Вам пришло новое сообщение.' },
    en: { title: 'New message', body: 'You have a new message.' },
  },
  [NotificationType.REVIEW_RECEIVED]: {
    uz: { title: 'Yangi sharh', body: 'Mijoz ishingizni baholadi.' },
    ru: { title: 'Новый отзыв', body: 'Клиент оценил вашу работу.' },
    en: { title: 'New review', body: 'A client rated your work.' },
  },
  [NotificationType.WALLET_TOPPED_UP]: {
    uz: { title: 'Balans to‘ldirildi', body: 'Hisobingiz to‘ldirildi.' },
    ru: { title: 'Баланс пополнен', body: 'Ваш счёт пополнен.' },
    en: { title: 'Wallet topped up', body: 'Your balance has been credited.' },
  },
  // Broadcasts always carry their own title and body; this is only the fallback.
  [NotificationType.ANNOUNCEMENT]: {
    uz: { title: 'Usta.uz', body: 'Jamoamizdan yangi xabar.' },
    ru: { title: 'Usta.uz', body: 'Новое сообщение от команды.' },
    en: { title: 'Usta.uz', body: 'A new message from the team.' },
  },
};

export type NotifyInput = {
  userId: string;
  type: NotificationType;
  data?: Record<string, string>;
  orderId?: string;
  chatId?: string;
  /** Overrides the localised default, e.g. to include a message preview. */
  title?: string;
  body?: string;
};

/**
 * Records a notification, pushes it down the open socket, and queues the device
 * push. The push goes through BullMQ so a slow or failing FCM call never blocks
 * the request that triggered it.
 */
export const notify = async (input: NotifyInput): Promise<NotificationDocument> => {
  const user = await User.findById(input.userId).select('language pushTokens').lean();
  if (!user) throw new NotFoundError('User');

  const copy = COPY[input.type][user.language];
  const ringing = input.type === NotificationType.ORDER_OFFER;

  const notification = await Notification.create({
    user: new mongoose.Types.ObjectId(input.userId),
    type: input.type,
    title: input.title ?? copy.title,
    body: input.body ?? copy.body,
    data: input.data ?? {},
    order: input.orderId ? new mongoose.Types.ObjectId(input.orderId) : undefined,
    chat: input.chatId ? new mongoose.Types.ObjectId(input.chatId) : undefined,
    isRinging: ringing,
  });

  emitToUser(input.userId, SocketEvent.NOTIFICATION, notification.toJSON());

  if (user.pushTokens.length > 0) {
    try {
      // Without a queue-capable Redis the push is sent inline. It is slower on
      // the request path, but a development machine sends few of them and the
      // alternative is no push at all.
      if (!isQueueCapable()) {
        await pushProvider.send(user.pushTokens, {
          title: notification.title,
          body: notification.body,
          data: { ...notification.data, type: notification.type },
          ringing,
        });
        notification.sentAt = new Date();
        await notification.save();
        return notification;
      }

      await getNotificationQueue().add(NotificationJob.PUSH, {
        notificationId: (notification._id).toString(),
        tokens: user.pushTokens,
        title: notification.title,
        body: notification.body,
        data: { ...notification.data, type: notification.type },
        ringing,
      });
    } catch (error) {
      // A queue outage must not fail the action that produced the notification;
      // the in-app record and the socket event have already landed.
      logger.warn('Could not queue a push notification', {
        userId: input.userId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return notification;
};

export const listForUser = async (
  userId: string,
  page: number,
  limit: number,
): Promise<Paginated<NotificationDocument>> => {
  const filter = { user: new mongoose.Types.ObjectId(userId) };
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).exec(),
    Notification.countDocuments(filter),
  ]);

  return paginate(items, total, page, limit);
};

export const unreadCount = (userId: string): Promise<number> =>
  Notification.countDocuments({ user: userId, isRead: false });

export const markRead = async (userId: string, notificationId: string): Promise<void> => {
  await Notification.updateOne(
    { _id: notificationId, user: userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  );
};

export const markAllRead = async (userId: string): Promise<void> => {
  await Notification.updateMany(
    { user: userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  );
};

/** Device registration — `$addToSet` keeps re-registration idempotent. */
export const registerDevice = async (userId: string, token: string): Promise<void> => {
  await User.updateOne({ _id: userId }, { $addToSet: { pushTokens: token } });
};

export const unregisterDevice = async (userId: string, token: string): Promise<void> => {
  await User.updateOne({ _id: userId }, { $pull: { pushTokens: token } });
};
