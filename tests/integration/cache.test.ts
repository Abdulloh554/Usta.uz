import { cached, invalidate } from '../../src/common/utils/cache';
import { redis } from '../../src/config/redis';

describe('read-through cache concurrency', () => {
  it('bypasses a disconnected Redis instead of queueing a page behind reconnection', async () => {
    redis.status = 'reconnecting';
    try {
      expect(await cached('audit:offline', 30, async () => 7)).toBe(7);
    } finally {
      redis.status = 'ready';
    }
  });
  it('shares one database loader when several dashboard requests miss at once', async () => {
    const load = jest.fn(async () => ({ count: 42 }));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => cached('audit:shared', 30, load)),
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(results).toEqual(Array.from({ length: 8 }, () => ({ count: 42 })));
  });

  it('does not put an old pending load back into the cache after a write invalidates it', async () => {
    let finish: (value: number) => void = () => undefined;
    let started: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const old = cached('audit:invalidated', 30, () => {
      started();
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    });
    await ready;
    await invalidate('audit:invalidated');
    expect(await cached('audit:invalidated', 30, async () => 2)).toBe(2);
    finish(1);
    expect(await old).toBe(1);
    expect(await redis.get('audit:invalidated')).toBe('2');
  });

  it('releases failed loaders so the next request can recover', async () => {
    await expect(
      cached('audit:failure', 30, async () => {
        throw new Error('DB unavailable');
      }),
    ).rejects.toThrow('DB unavailable');
    expect(await cached('audit:failure', 30, async () => 3)).toBe(3);
  });
});
