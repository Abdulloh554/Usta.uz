import { Worker, type Job } from 'bullmq';
import { createQueueConnection } from '../config/redis';
import { logger } from '../config/logger';
import { pushProvider } from '../config/push';
import { Notification } from '../modules/notification/notification.model';
import { NotificationJob, QueueName } from './queues';

type PushData = {
  notificationId: string;
  tokens: string[];
  title: string;
  body: string;
  data: Record<string, string>;
  ringing: boolean;
};

type ReminderData = { orderId: string; masterId: string };

export const createNotificationWorker = (): Worker => {
  const worker = new Worker(
    QueueName.NOTIFICATION,
    async (job: Job<PushData | ReminderData>) => {
      switch (job.name) {
        case NotificationJob.PUSH: {
          const payload = job.data as PushData;
          await pushProvider.send(payload.tokens, {
            title: payload.title,
            body: payload.body,
            data: payload.data,
            ringing: payload.ringing,
          });
          await Notification.updateOne(
            { _id: payload.notificationId },
            { $set: { sentAt: new Date() } },
          );
          return;
        }
        case NotificationJob.COMPLETION_REMINDER: {
          const { orderId, masterId } = job.data as ReminderData;
          logger.info('Completion reminder due', { orderId, masterId });
          return;
        }
        default:
          logger.warn('Unknown notification job', { name: job.name, id: job.id });
      }
    },
    {
      connection: createQueueConnection('notification-worker'),
      concurrency: 16,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error('Notification job failed', { name: job?.name, id: job?.id, message: error.message });
  });

  worker.on('error', (error) => {
    logger.error('Notification worker error', { message: error.message });
  });

  return worker;
};
