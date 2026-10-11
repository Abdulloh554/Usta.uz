import { redis } from '../../config/redis';

const patterns = [
  'auth:*',
  'sms:*',
  'match:*',
  'presence:*',
  'cache:stats:*',
  'cache:top:*',
  'cache:categories',
  'ratelimit:global:*',
  'ratelimit:auth:*',
  'ratelimit:sms:*',
  'ratelimit:order:*',
  'ratelimit:webhook:*',
  'bull:matching:*',
  'bull:notification:*',
];

async function applicationKeys(): Promise<string[]> {
  const found = new Set<string>();
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index]!;
    let cursor = '0';
    do {
      // eslint-disable-next-line no-await-in-loop
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      keys.forEach((key) => found.add(key));
    } while (cursor !== '0');
  }
  return Array.from(found);
}

/** Explicit maintenance flag only; each token is consumed once across workers/restarts. */
export async function resetRedisOnce(
  token: string,
): Promise<{ removed: number; remaining: number } | null> {
  if (!token) return null;
  const marker = `maintenance:redis-reset:${token}`;
  if ((await redis.get(marker)) === 'done') return null;
  const acquired = await redis.set(marker, 'running', 'NX');
  if (!acquired) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      if ((await redis.get(marker)) === 'done') return null;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    throw new Error('Redis maintenance is still running');
  }
  try {
    const keys = await applicationKeys();
    for (let offset = 0; offset < keys.length; offset += 100) {
      // eslint-disable-next-line no-await-in-loop
      await redis.del(...keys.slice(offset, offset + 100));
    }
    const remaining = (await applicationKeys()).length;
    if (remaining !== 0) throw new Error('Redis maintenance did not finish');
    await redis.set(marker, 'done');
    return { removed: keys.length, remaining };
  } catch (error) {
    await redis.del(marker);
    throw error;
  }
}
