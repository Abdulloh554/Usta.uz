import { redis } from '../../src/config/redis';
import { resetRedisOnce } from '../../src/common/utils/resetRedis';

describe('one-time Redis maintenance', () => {
  it('does nothing without an explicit token', async () => {
    await redis.set('auth:test', 'session');
    expect(await resetRedisOnce('')).toBeNull();
    expect(await redis.get('auth:test')).toBe('session');
  });

  it('removes only the project keys and never repeats a consumed token', async () => {
    await redis.set('auth:test', 'session');
    await redis.set('bull:matching:test', 'job');
    await redis.set('cache:stats:overview', 'old stats');
    await redis.set('other-project:data', 'keep');
    expect(await resetRedisOnce('test-cleanup')).toEqual({ removed: 3, remaining: 0 });
    expect(await redis.get('other-project:data')).toBe('keep');
    await redis.set('auth:new-session', 'new');
    expect(await resetRedisOnce('test-cleanup')).toBeNull();
    expect(await redis.get('auth:new-session')).toBe('new');
  });

  it('releases the maintenance marker after failure so cleanup can be retried', async () => {
    await redis.set('auth:test', 'old');
    const spy = jest.spyOn(redis, 'del').mockRejectedValueOnce(new Error('Connection lost'));
    await expect(resetRedisOnce('test-retry')).rejects.toThrow('Connection lost');
    spy.mockRestore();
    expect(await redis.get('maintenance:redis-reset:test-retry')).toBeNull();
    expect(await resetRedisOnce('test-retry')).toEqual({ removed: 1, remaining: 0 });
  });
});
