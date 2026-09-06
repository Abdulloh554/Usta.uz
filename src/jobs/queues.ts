import { Queue, type JobsOptions } from 'bullmq';
import { createQueueConnection } from '../config/redis';
import { logger } from '../config/logger';

export const QueueName = {
  MATCHING: 'matching',
  NOTIFICATION: 'notification',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const MatchingJob = {
  /** Fires when a pro has not answered an offer within the timeout. */
  OFFER_TIMEOUT: 'offer-timeout',
  /** Re-runs matching for a job that found nobody the first time round. */
  RETRY_SEARCH: 'retry-search',
} as const;
export type MatchingJob = (typeof MatchingJob)[keyof typeof MatchingJob];

export const NotificationJob = {
  PUSH: 'push',
  /** Nudges a pro who accepted a job but has not marked it complete. */
  COMPLETION_REMINDER: 'completion-reminder',
} as const;
export type NotificationJob = (typeof NotificationJob)[keyof typeof NotificationJob];

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
};

let matchingQueue: Queue | null = null;
let notificationQueue: Queue | null = null;

/**
 * Queues connect lazily. Nothing in the request path should force a Redis
 * connection just by importing this module — tests in particular run with no
 * Redis at all.
 */
export const getMatchingQueue = (): Queue => {
  matchingQueue ??= new Queue(QueueName.MATCHING, {
    connection: createQueueConnection(QueueName.MATCHING),
    defaultJobOptions,
  });
  return matchingQueue;
};

export const getNotificationQueue = (): Queue => {
  notificationQueue ??= new Queue(QueueName.NOTIFICATION, {
    connection: createQueueConnection(QueueName.NOTIFICATION),
    defaultJobOptions,
  });
  return notificationQueue;
};

/**
 * A deterministic job id per (order, pro) pair: re-offering the same job to the
 * same pro cannot leave two timeouts racing, and cancelling is a lookup rather
 * than a scan.
 */
export const offerTimeoutJobId = (orderId: string, masterId: string): string =>
  `offer:${orderId}:${masterId}`;

export const scheduleOfferTimeout = async (
  orderId: string,
  masterId: string,
  delaySeconds: number,
): Promise<void> => {
  await getMatchingQueue().add(
    MatchingJob.OFFER_TIMEOUT,
    { orderId, masterId },
    {
      delay: delaySeconds * 1_000,
      jobId: offerTimeoutJobId(orderId, masterId),
      // One shot. If the worker fails, the next offer will be driven by the
      // client re-polling rather than by a retry that fires minutes late.
      attempts: 1,
      removeOnComplete: true,
    },
  );
};

export const cancelOfferTimeout = async (orderId: string, masterId: string): Promise<void> => {
  try {
    const job = await getMatchingQueue().getJob(offerTimeoutJobId(orderId, masterId));
    await job?.remove();
  } catch (error) {
    // A timeout that has already fired cannot be removed; that is harmless
    // because the worker re-checks the outstanding offer before acting.
    logger.debug('Could not cancel offer timeout', {
      orderId,
      masterId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export const closeQueues = async (): Promise<void> => {
  await Promise.allSettled([matchingQueue?.close(), notificationQueue?.close()]);
  matchingQueue = null;
  notificationQueue = null;
};
