import { redis } from '../../config/redis';

/** Never delete a lease or reservation that has been replaced by another owner. */
export const deleteIfValue = async (key: string, value: string): Promise<number> =>
  Number(
    await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      key,
      value,
    ),
  );

export const renewIfValue = async (key: string, value: string, ttl: number): Promise<number> =>
  Number(
    await redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0",
      1,
      key,
      value,
      ttl,
    ),
  );
