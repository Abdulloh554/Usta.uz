import Redis, { type RedisOptions } from 'ioredis';
import { env } from './env';
import { logger } from './logger';

const baseOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 200, 5_000),
};

const clients = new Set<Redis>();

const create = (label: string, options: RedisOptions = {}): Redis => {
  const client = new Redis(env.REDIS_URL, { ...baseOptions, ...options });

  client.on('error', (error: Error) => {
    logger.error(`Redis (${label}) error`, { message: error.message });
  });
  client.on('ready', () => {
    logger.info(`Redis (${label}) ready`);
  });

  clients.add(client);
  return client;
};

/** General-purpose client: caching, SMS codes, refresh-token allow list, matching queue state. */
export const redis = create('app');

/**
 * BullMQ requires `maxRetriesPerRequest: null` and its own connections; sharing
 * the app client would let a blocking `BRPOPLPUSH` starve ordinary commands.
 */
export const createQueueConnection = (label: string): Redis => create(`queue:${label}`);

export const connectRedis = async (): Promise<void> => {
  if (redis.status === 'ready' || redis.status === 'connecting') return;
  await redis.connect();
};

export const disconnectRedis = async (): Promise<void> => {
  await Promise.all(
    [...clients].map(async (client) => {
      if (client.status === 'end') return;
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }),
  );
  clients.clear();
};

/** Namespaced key builders, so every module agrees on the layout of the keyspace. */
export const keys = {
  smsCode: (phone: string): string => `sms:code:${phone}`,
  smsAttempts: (phone: string): string => `sms:attempts:${phone}`,
  refreshToken: (userId: string, tokenId: string): string => `auth:refresh:${userId}:${tokenId}`,
  refreshTokensOfUser: (userId: string): string => `auth:refresh:${userId}:*`,
  /** Unix seconds; access tokens this user was issued before it are refused. */
  revokedBefore: (userId: string): string => `auth:revoked-before:${userId}`,
  /** Ordered candidate list for one order's matching run. */
  matchQueue: (orderId: string): string => `match:queue:${orderId}`,
  /** The offer currently outstanding for an order: which pro, since when. */
  matchOffer: (orderId: string): string => `match:offer:${orderId}`,
  /** Reverse index so a pro can be shown their outstanding offer on reconnect. */
  masterOffer: (masterId: string): string => `match:master:${masterId}`,
  onlineMaster: (masterId: string): string => `presence:master:${masterId}`,
  onlineMasters: 'presence:masters',
  socketsOfUser: (userId: string): string => `presence:sockets:${userId}`,
  categoryCache: 'cache:categories',
  topMasters: (category: string, region: string): string => `cache:top:${category}:${region}`,
} as const;
