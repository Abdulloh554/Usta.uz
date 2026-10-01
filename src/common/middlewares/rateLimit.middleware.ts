import type { Request } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redis } from '../../config/redis';
import { env, isTest } from '../../config/env';
import { verifyAccessToken } from '../utils/token';
import { TooManyRequestsError } from '../errors/ApiError';

/**
 * Rate limit state lives in Redis so the window holds across API instances —
 * a per-process counter would let an attacker multiply their budget by the
 * number of replicas behind the load balancer.
 */
const store = (prefix: string): Options['store'] | undefined =>
  isTest
    ? undefined
    : new RedisStore({
        prefix: `ratelimit:${prefix}:`,
        sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as Promise<never>,
      });

/**
 * A signed-in request is counted against the account, anonymous ones against
 * the address.
 *
 * Uzbek mobile networks put very large numbers of subscribers behind a handful
 * of carrier-grade NAT addresses, so counting everything by IP means strangers
 * share one budget: a few busy users on Beeline would spend it and everyone
 * else on that carrier would be refused. The account is the unit the limit is
 * actually about, and it is also the one an attacker cannot rotate for free.
 */
const keyFor = (req: Request): string => {
  const header = req.headers.authorization;

  if (header?.startsWith('Bearer ')) {
    try {
      return `u:${verifyAccessToken(header.slice(7).trim()).sub}`;
    } catch {
      // An expired or forged token spends the anonymous budget, like no token.
    }
  }

  const ip = req.ip ?? 'unknown';
  // A single IPv6 address is not a meaningful unit — subscribers are handed
  // whole blocks — so the first four groups (the /64) are the subject.
  return `ip:${ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip}`;
};

const build = (prefix: string, windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: store(prefix),
    keyGenerator: keyFor,
    // Skip entirely under test so integration suites are not throttled.
    skip: () => isTest,
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError(message));
    },
  });

/** Everything under the API prefix. */
export const globalLimiter = build(
  'global',
  60_000,
  env.RATE_LIMIT_GLOBAL_MAX,
  'Too many requests, slow down',
);

/** Login and register: brute-force protection on the credential surface. */
export const authLimiter = build(
  'auth',
  15 * 60_000,
  10,
  'Too many authentication attempts, try again in 15 minutes',
);

/** SMS costs money and is the most abusable endpoint in the app. */
export const smsLimiter = build('sms', 60 * 60_000, 5, 'Too many SMS requests, try again in an hour');

/** Posting jobs — stops a client flooding the matching queue. */
export const orderCreateLimiter = build('order', 60 * 60_000, 20, 'Too many jobs posted, try again later');

/**
 * Payment callbacks are unauthenticated by nature, so they are the one money
 * path a stranger can reach. The ceiling is well above what Payme and Click
 * actually send, including their retries — it exists to stop a flood, not to
 * shape normal traffic.
 */
export const webhookLimiter = build(
  'webhook',
  60_000,
  120,
  'Too many callback requests',
);
