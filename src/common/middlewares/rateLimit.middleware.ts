import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redis } from '../../config/redis';
import { env, isTest } from '../../config/env';
import { verifyAccessToken } from '../utils/token';
import { TooManyRequestsError } from '../errors/ApiError';
import { normalizePhone } from '../utils/phone';

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

/** Constant-time, and length-independent because both sides are hashed first. */
const sameSecret = (offered: string, expected: string): boolean =>
  timingSafeEqual(
    createHash('sha256').update(offered).digest(),
    createHash('sha256').update(expected).digest(),
  );

/**
 * The address a request is counted against. Normally `req.ip`; for the web
 * app's own server — which relays sign-in and refresh for every web visitor —
 * the visitor's address it forwards, but only alongside the shared secret, so
 * nobody else can pick the bucket they are counted in.
 */
export const clientIp = (req: Request): string => {
  const secret = env.BFF_SHARED_SECRET;
  const offered = req.headers['x-bff-secret'];
  const claimed = req.headers['x-client-ip'];

  if (
    secret &&
    typeof offered === 'string' &&
    typeof claimed === 'string' &&
    isIP(claimed) !== 0 &&
    sameSecret(offered, secret)
  ) {
    return claimed;
  }

  return req.ip ?? 'unknown';
};

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
export const keyFor = (req: Request): string => {
  const header = req.headers.authorization;

  if (header?.startsWith('Bearer ')) {
    try {
      return `u:${verifyAccessToken(header.slice(7).trim()).sub}`;
    } catch {
      // An expired or forged token spends the anonymous budget, like no token.
    }
  }

  const ip = clientIp(req);
  // A single IPv6 address is not a meaningful unit — subscribers are handed
  // whole blocks — so the first four groups (the /64) are the subject.
  return `ip:${ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip}`;
};

/**
 * Counts against the phone number in the body rather than the caller, so a
 * credential-stuffing run against one account is capped however many
 * addresses it is spread over. The number is normalised first — `90 123 45 67`
 * and `+998901234567` are the same account and must share one bucket. A body
 * without a usable number falls back to the caller's key; validation rejects
 * that request anyway.
 */
export const phoneKeyFor = (req: Request): string => {
  const raw = (req.body as { phone?: unknown } | undefined)?.phone;
  if (typeof raw === 'string') {
    try {
      return `phone:${normalizePhone(raw)}`;
    } catch {
      // Not a valid Uzbek number — fall through to the caller's key.
    }
  }
  return keyFor(req);
};

type BuildOptions = Pick<Partial<Options>, 'keyGenerator' | 'skipSuccessfulRequests'>;

const build = (
  prefix: string,
  windowMs: number,
  max: number,
  message: string,
  options: BuildOptions = {},
) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: store(prefix),
    keyGenerator: keyFor,
    ...options,
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

/** Register and password reset: brute-force protection on the credential surface. */
export const authLimiter = build(
  'auth',
  15 * 60_000,
  10,
  'Too many authentication attempts, try again in 15 minutes',
);

/**
 * Login by address. Deliberately loose: carrier-grade NAT puts thousands of
 * Uzbek subscribers behind one IP, so a tight per-IP ceiling locks strangers
 * out of each other's sign-in. The per-phone limiter below is the real
 * brute-force guard.
 */
export const loginIpLimiter = build(
  'login-ip',
  15 * 60_000,
  50,
  'Too many sign-in attempts, try again in 15 minutes',
);

/** Failed logins per account (normalised phone). Successful sign-ins do not count. */
export const loginPhoneLimiter = build(
  'login-phone',
  15 * 60_000,
  10,
  'Too many failed sign-in attempts for this number, try again in 15 minutes',
  { keyGenerator: phoneKeyFor, skipSuccessfulRequests: true },
);

/** Phone lookups reveal whether a number is registered — cap enumeration. */
export const checkPhoneLimiter = build(
  'check-phone',
  60_000,
  20,
  'Too many phone checks, slow down',
);

/** Password-reset requests per phone number. */
export const forgotPasswordPhoneLimiter = build(
  'forgot-phone',
  60 * 60_000,
  3,
  'Too many password reset requests for this number, try again in an hour',
  { keyGenerator: phoneKeyFor },
);

/** SMS costs money and is the most abusable endpoint in the app. */
export const smsLimiter = build('sms', 60 * 60_000, 5, 'Too many SMS requests, try again in an hour');

/** Posting jobs — stops a client flooding the matching queue. */
export const orderCreateLimiter = build('order', 60 * 60_000, 20, 'Too many jobs posted, try again later');

export const assistantLimiter = build('assistant', 10 * 60_000, 20, 'AI so‘rovlar limiti. 10 daqiqadan so‘ng qayta urining.');

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

/** Manual top-up requests per account — each one lands in an admin's queue. */
export const topUpRequestLimiter = build(
  'topup',
  60 * 60_000,
  10,
  'Too many top-up requests, try again in an hour',
);
