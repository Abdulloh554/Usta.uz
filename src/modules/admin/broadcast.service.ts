import mongoose, { type FilterQuery } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { supportsTransactions } from '../../config/database';
import { logger } from '../../config/logger';
import { NotFoundError, ServiceUnavailableError } from '../../common/errors/ApiError';
import { UserRole, NotificationType } from '../../common/types';
import { User, type IUser } from '../user/user.model';
import { Notification, type NotificationDocument } from '../notification/notification.model';
import { emitToUser } from '../../sockets/emitter';
import { SocketEvent } from '../../sockets/events';
import { getNotificationQueue, NotificationJob } from '../../jobs/queues';
import { isQueueCapable } from '../../jobs/scheduler';
import { Broadcast, type IBroadcast } from './broadcast.model';
import { AdminLog, AdminAction, AdminTarget } from './adminLog.model';
import type { BroadcastInput } from './admin.validator';

const BATCH_SIZE = 250;
const audienceFilter = (audience: IBroadcast['audience'], cutoff: Date): FilterQuery<IUser> => ({
  isActive: true,
  isBlocked: false,
  createdAt: { $lte: cutoff },
  role: audience === 'all' ? { $ne: UserRole.ADMIN } : audience,
});

export const queueBroadcast = async (adminId: string, input: BroadcastInput) => {
  if (!supportsTransactions())
    throw new ServiceUnavailableError(
      'Broadcasts require a replica-set database',
      'TRANSACTIONS_REQUIRED',
    );
  const cutoff = new Date();
  const recipients = await User.countDocuments(audienceFilter(input.audience, cutoff)).maxTimeMS(
    15_000,
  );
  const job = await Broadcast.create({ ...input, admin: adminId, cutoff, recipients });
  return { jobId: String(job._id), status: job.status, recipients, delivered: 0 };
};

export const getBroadcast = async (id: string) => {
  const job = await Broadcast.findById(id);
  if (!job) throw new NotFoundError('Broadcast');
  return job;
};

/** One bounded, durable batch. Progress and notifications commit together. */
export const processBroadcastBatch = async (): Promise<boolean> => {
  if (!supportsTransactions()) return false;
  const owner = randomUUID();
  const claimed = await Broadcast.findOneAndUpdate(
    {
      status: { $in: ['queued', 'processing'] },
      leaseUntil: { $lte: new Date() },
    },
    {
      $set: { status: 'processing', leaseOwner: owner, leaseUntil: new Date(Date.now() + 60_000) },
    },
    { new: true, sort: { createdAt: 1 } },
  );
  if (!claimed) return false;
  const session = await mongoose.startSession();
  let created: NotificationDocument[] = [];
  let tokens = new Map<string, string[]>();
  try {
    await session.withTransaction(
      async () => {
        const job = await Broadcast.findOne({ _id: claimed._id, leaseOwner: owner }).session(
          session,
        );
        if (!job) throw new Error('Broadcast lease was replaced');
        const filter = audienceFilter(job.audience, job.cutoff);
        if (job.lastUser) filter._id = { $gt: job.lastUser };
        const users = await User.find(filter)
          .select('_id pushTokens')
          .sort({ _id: 1 })
          .limit(BATCH_SIZE)
          .session(session)
          .lean()
          .hint(
            job.audience === 'all' ? { _id: 1 } : { isActive: 1, isBlocked: 1, role: 1, _id: 1 },
          )
          .maxTimeMS(10_000);
        tokens = new Map(users.map((user) => [String(user._id), user.pushTokens ?? []]));
        created = users.length
          ? await Notification.insertMany(
              users.map((user) => ({
                user: user._id,
                type: NotificationType.ANNOUNCEMENT,
                title: job.title,
                body: job.body,
                data: { kind: 'announcement', broadcastId: String(job._id) },
              })),
              { session, ordered: true },
            )
          : [];
        job.delivered += users.length;
        if (users.length) job.lastUser = users[users.length - 1]!._id;
        job.attempts = 0;
        if (users.length < BATCH_SIZE) {
          job.status = 'completed';
          await AdminLog.create(
            [
              {
                admin: job.admin,
                action: AdminAction.BROADCAST_SENT,
                targetType: AdminTarget.BROADCAST,
                targetId: job._id,
                summary: job.title,
                meta: {
                  audience: job.audience,
                  title: job.title,
                  body: job.body,
                  recipients: job.recipients,
                  delivered: job.delivered,
                },
              },
            ],
            { session },
          );
        }
        job.leaseOwner = undefined;
        job.leaseUntil = new Date(0);
        await job.save({ session });
      },
      { maxCommitTimeMS: 10_000 },
    );
  } catch (error) {
    logger.error('Broadcast batch failed', { jobId: String(claimed._id), message: String(error) });
    const attempts = claimed.attempts + 1;
    await Broadcast.updateOne(
      { _id: claimed._id, leaseOwner: owner },
      {
        $set: {
          status: attempts >= 5 ? 'failed' : 'queued',
          attempts,
          leaseUntil: new Date(Date.now() + 10_000),
        },
        $unset: { leaseOwner: 1 },
      },
    );
    return true;
  } finally {
    await session.endSession();
  }

  // Post-commit fan-out does not hold the HTTP request or database transaction.
  created.forEach((notification) =>
    emitToUser(String(notification.user), SocketEvent.NOTIFICATION, notification.toJSON()),
  );
  const pushes = created.filter((notification) => tokens.get(String(notification.user))?.length);
  if (pushes.length && isQueueCapable()) {
    await getNotificationQueue()
      .addBulk(
        pushes.map((notification) => ({
          name: NotificationJob.PUSH,
          opts: { jobId: `notification-${String(notification._id)}` },
          data: {
            notificationId: String(notification._id),
            tokens: tokens.get(String(notification.user)),
            title: notification.title,
            body: notification.body,
            data: { ...notification.data, type: notification.type },
            ringing: false,
          },
        })),
      )
      .catch((error: unknown) =>
        logger.error('Broadcast push enqueue failed; in-app notifications are stored', {
          message: String(error),
        }),
      );
  }
  return true;
};
