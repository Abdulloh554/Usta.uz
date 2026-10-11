import { redis } from '../../config/redis';
import { logger } from '../../config/logger';

const pending = new Map<string, Promise<unknown>>();
const cacheDeadline = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cache operation timed out')), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const readAndLoad = async <T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
  current: () => boolean,
): Promise<T> => {
  try {
    const hit = await cacheDeadline(redis.get(key));
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (error) {
    logger.debug('Cache read failed', {
      key,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const value = await load();
  if (!current()) return value;

  try {
    await cacheDeadline(redis.set(key, JSON.stringify(value), 'EX', ttlSeconds));
  } catch (error) {
    logger.debug('Cache write failed', {
      key,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return value;
};

/**
 * Read-through cache over Redis, shared by every instance.
 *
 * Redis is treated as an accelerator and never as a dependency: a miss, a parse
 * failure or an outage all fall through to the loader, so the endpoint keeps
 * working and merely costs what it cost before. A TTL of zero bypasses the
 * cache entirely, which is how the suite reads live values.
 */
export const cached = async <T>(
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> => {
  if (ttlSeconds <= 0 || redis.status !== 'ready') return load();
  const shared = pending.get(key);
  if (shared) return shared as Promise<T>;

  const operation: Promise<T> = readAndLoad(
    key,
    ttlSeconds,
    load,
    () => pending.get(key) === operation,
  );
  pending.set(key, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(key) === operation) pending.delete(key);
  }
};

/** Drops cached entries after a write that makes them wrong. */
export const invalidate = async (...keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  keys.forEach((key) => pending.delete(key));
  if (redis.status !== 'ready') return;
  try {
    await cacheDeadline(redis.del(...keys));
  } catch (error) {
    logger.debug('Cache invalidation failed', {
      keys,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
