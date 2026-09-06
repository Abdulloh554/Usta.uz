import { redis } from '../config/redis';
import { logger } from '../config/logger';

/**
 * BullMQ needs Redis 5 or newer — it is built on streams, which 4.x and older do
 * not have. Windows developers often have the abandoned 3.0.504 Microsoft port
 * installed, and against that every worker throws on a loop and the 45-second
 * offer timeout never fires, which silently breaks matching.
 *
 * Rather than let that fail quietly, the server probes the server version once
 * at boot. Where Redis is too old it falls back to in-process timers, which are
 * correct for a single instance — they are lost on restart and do not span
 * replicas, so this is a development aid and the log says so plainly.
 */
const MINIMUM_MAJOR = 5;

let queueCapable: boolean | null = null;

const parseMajor = (info: string): number => {
  const match = /redis_version:(\d+)\./.exec(info);
  return match ? Number(match[1]) : 0;
};

export const probeQueueSupport = async (): Promise<boolean> => {
  if (queueCapable !== null) return queueCapable;

  try {
    const info = await redis.info('server');
    const major = parseMajor(info);
    queueCapable = major >= MINIMUM_MAJOR;

    if (!queueCapable) {
      logger.warn(
        `Redis ${major}.x is too old for BullMQ (needs ${MINIMUM_MAJOR}+). ` +
          'Falling back to in-process timers: job offers will still time out ' +
          'correctly on this instance, but not across restarts or replicas.',
      );
    }
  } catch (error) {
    queueCapable = false;
    logger.warn('Could not read the Redis version — assuming no queue support', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return queueCapable;
};

export const isQueueCapable = (): boolean => queueCapable === true;

/* — the in-process fallback — */

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const cancelLocal = (key: string): void => {
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
    timers.delete(key);
  }
};

export const scheduleLocal = (key: string, delaySeconds: number, run: () => Promise<void>): void => {
  cancelLocal(key);

  const timer = setTimeout(() => {
    timers.delete(key);
    void run().catch((error: unknown) => {
      logger.error('In-process scheduled task failed', {
        key,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, delaySeconds * 1_000);

  // Do not hold the process open just because a timeout is pending.
  timer.unref?.();
  timers.set(key, timer);
};

export const clearLocalTimers = (): void => {
  timers.forEach((timer) => clearTimeout(timer));
  timers.clear();
};
