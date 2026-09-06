import type { Worker } from 'bullmq';
import { logger } from '../config/logger';
import { closeQueues } from './queues';
import { createMatchingWorker } from './matching.worker';
import { createNotificationWorker } from './notification.worker';
import { clearLocalTimers, probeQueueSupport } from './scheduler';

let workers: Worker[] = [];

/**
 * Starting a BullMQ worker against a Redis older than 5 produces an endless
 * stream of errors and no working jobs, so the version is checked first and the
 * in-process fallback is used instead.
 */
export const startWorkers = async (): Promise<void> => {
  if (workers.length > 0) return;

  if (!(await probeQueueSupport())) {
    logger.info('Background workers skipped — using in-process timers');
    return;
  }

  workers = [createMatchingWorker(), createNotificationWorker()];
  logger.info('Background workers started', { count: workers.length });
};

export const stopWorkers = async (): Promise<void> => {
  clearLocalTimers();
  await Promise.allSettled(workers.map((worker) => worker.close()));
  workers = [];
  await closeQueues();
  logger.info('Background workers stopped');
};
