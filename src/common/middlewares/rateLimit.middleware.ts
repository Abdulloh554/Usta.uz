import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redis } from '../../config/redis';
import { isTest } from '../../config/env';
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

const build = (prefix: string, windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: store(prefix),
    // Skip entirely under test so integration suites are not throttled.
    skip: () => isTest,
    handler: (_req, _res, next) => {
      next(new TooManyRequestsError(message));
    },
  });

/** Everything under the API prefix. */
export const globalLimiter = build('global', 60_000, 300, 'Too many requests, slow down');

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
