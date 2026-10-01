import { redis } from '../../config/redis';
import { logger } from '../../config/logger';

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
  if (ttlSeconds <= 0) return load();

  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (error) {
    logger.debug('Cache read failed', {
      key,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const value = await load();

  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (error) {
    logger.debug('Cache write failed', {
      key,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return value;
};

/** Drops cached entries after a write that makes them wrong. */
export const invalidate = async (...keys: string[]): Promise<void> => {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (error) {
    logger.debug('Cache invalidation failed', {
      keys,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
