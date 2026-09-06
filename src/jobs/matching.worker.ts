import { Worker, type Job } from 'bullmq';
import { createQueueConnection } from '../config/redis';
import { logger } from '../config/logger';
import { expireOffer, startMatching } from '../modules/matching/matching.service';
import { MatchingJob, QueueName } from './queues';

type OfferTimeoutData = { orderId: string; masterId: string };
type RetrySearchData = { orderId: string };

/**
 * Drives the 45-second offer window. When a pro does not answer, this hands the
 * job to the next candidate — the "if you pass, the job goes to the next pro"
 * promise on the pro's feed card.
 *
 * `expireOffer` re-reads the outstanding offer before acting, so a job that
 * fires a moment after the pro accepted is a no-op rather than a mis-expiry.
 */
export const createMatchingWorker = (): Worker => {
  const worker = new Worker(
    QueueName.MATCHING,
    async (job: Job<OfferTimeoutData | RetrySearchData>) => {
      switch (job.name) {
        case MatchingJob.OFFER_TIMEOUT: {
          const { orderId, masterId } = job.data as OfferTimeoutData;
          await expireOffer(orderId, masterId);
          return;
        }
        case MatchingJob.RETRY_SEARCH: {
          const { orderId } = job.data as RetrySearchData;
          await startMatching(orderId);
          return;
        }
        default:
          logger.warn('Unknown matching job', { name: job.name, id: job.id });
      }
    },
    {
      connection: createQueueConnection('matching-worker'),
      // Offers are short-lived and cheap to process; a small pool is plenty and
      // keeps ordering predictable within one job's candidate list.
      concurrency: 8,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error('Matching job failed', {
      name: job?.name,
      id: job?.id,
      data: job?.data,
      message: error.message,
    });
  });

  worker.on('error', (error) => {
    logger.error('Matching worker error', { message: error.message });
  });

  return worker;
};
