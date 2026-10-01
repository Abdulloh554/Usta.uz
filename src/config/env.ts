import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the process reads passes through this schema.
 * A malformed value fails the boot rather than surfacing as a runtime error
 * hours later, so `env` is safe to treat as fully typed everywhere else.
 */
/**
 * `z.coerce.boolean()` is no use here: it follows JavaScript truthiness, so the
 * string `'false'` would read as `true`. Only an explicit `false` or `0` is off.
 */
const booleanish = z
  .string()
  .transform((value) => value !== 'false' && value !== '0');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  /**
   * Shared with the web app's auth route handlers (`web/src/app/api/auth`).
   * Those call the API from the web server, so without this every web visitor
   * would arrive from that one address and share a single rate-limit budget.
   * A request carrying the secret in `X-BFF-Secret` may name the real client
   * in `X-Client-IP`; without it, or when unset, that header is ignored.
   */
  BFF_SHARED_SECRET: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(32, 'BFF_SHARED_SECRET must be at least 32 characters').optional(),
  ),

  /**
   * 0 means one worker per CPU. 1 — the default — keeps the single-process
   * behaviour, which is what a one-core container wants; more workers there
   * only add context switching. Raise it on a host with cores to spare.
   */
  CLUSTER_WORKERS: z.coerce.number().int().nonnegative().default(1),
  /** How long a shutdown waits for in-flight work before it forces the exit. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * Must exceed the idle timeout of whatever proxy sits in front, so the proxy
   * closes an idle connection first. A shorter server-side timeout is the usual
   * cause of sporadic 502s behind a load balancer.
   */
  KEEP_ALIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(65_000),
  /** 0 disables it. Caps a request that would otherwise hold a socket forever. */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),

  MONGO_URI: z.string().min(1),
  /**
   * Each instance holds its own pool, so the ceiling across every replica has to
   * stay under what the cluster allows (Atlas M10 permits 1 500).
   */
  MONGO_MAX_POOL: z.coerce.number().int().positive().default(50),
  MONGO_MIN_POOL: z.coerce.number().int().nonnegative().default(5),
  /**
   * Mongoose builds every declared index at boot. That is right for a small
   * database and wrong for a large one, where it stalls the start and can lock
   * writes — turn it off there and run `npm run indexes:sync` as a release step.
   */
  MONGO_AUTO_INDEX: booleanish.default('true'),

  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  /**
   * `bcryptjs` is pure JavaScript and so costs real CPU on the API process
   * itself: measured here, 12 rounds is ~420 ms per hash against ~110 ms at 10.
   * Ten rounds is still the figure OWASP considers sound for bcrypt, and it
   * raises how many sign-ins a core can serve roughly fourfold. Existing hashes
   * carry their own cost factor, so changing this never invalidates a password.
   */
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  SMS_PROVIDER: z.enum(['eskiz', 'playmobile', 'console']).default('console'),
  ESKIZ_BASE_URL: z.string().default('https://notify.eskiz.uz/api'),
  ESKIZ_EMAIL: z.string().default(''),
  ESKIZ_PASSWORD: z.string().default(''),
  ESKIZ_FROM: z.string().default('4546'),
  PLAYMOBILE_BASE_URL: z.string().default('https://send.smsxabar.uz/broker-api'),
  PLAYMOBILE_LOGIN: z.string().default(''),
  PLAYMOBILE_PASSWORD: z.string().default(''),
  SMS_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SMS_CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /**
   * The pro pays this, once, when accepting a job. The app takes no cut of the
   * work itself. 0 — the launch default — turns payments off entirely: accepting
   * is free, there is no sign-up bonus and top-ups are refused. Set it back to
   * 4999 once Payme / Click are connected.
   */
  ORDER_ACCEPT_FEE: z.coerce.number().int().nonnegative().default(0),
  PAYME_MERCHANT_ID: z.string().default(''),
  PAYME_KEY: z.string().default(''),
  PAYME_CHECKOUT_URL: z.string().default('https://checkout.paycom.uz'),
  CLICK_MERCHANT_ID: z.string().default(''),
  CLICK_SERVICE_ID: z.string().default(''),
  CLICK_SECRET_KEY: z.string().default(''),
  CLICK_CHECKOUT_URL: z.string().default('https://my.click.uz/services/pay'),

  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),

  FCM_PROJECT_ID: z.string().default(''),
  FCM_CLIENT_EMAIL: z.string().default(''),
  FCM_PRIVATE_KEY: z.string().default(''),
  /**
   * Web Push (VAPID) for the web app. Generate once with
   * `npx web-push generate-vapid-keys`; empty disables browser push, and
   * browser subscriptions are then skipped rather than sent anywhere.
   */
  WEB_PUSH_PUBLIC_KEY: z.string().default(''),
  WEB_PUSH_PRIVATE_KEY: z.string().default(''),
  /** Who push services may contact about this sender — a `mailto:` or `https:` URL. */
  WEB_PUSH_SUBJECT: z.string().default('mailto:support@usta.uz'),

  MATCH_OFFER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(45),
  /**
   * How long after a pro's last activity they still count as reachable. Closing
   * the app drops the socket, but the push notification is exactly what should
   * reach them then — so a recently-seen pro stays in the candidate list.
   */
  MATCH_OFFLINE_GRACE_MINUTES: z.coerce.number().int().nonnegative().default(30),
  MATCH_MAX_CANDIDATES: z.coerce.number().int().positive().default(20),
  MATCH_RADIUS_KM: z.coerce.number().positive().default(15),

  SENTRY_DSN: z.string().default(''),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),

  /** Requests per minute under the API prefix, per signed-in user or per IP. */
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
  /**
   * Scaling past one instance means a client's polling requests can land on
   * different replicas, and Socket.IO's handshake cannot survive that without
   * sticky sessions. Restricting the transport to `websocket` removes the
   * requirement — one connection, one instance, for its whole life.
   */
  SOCKET_TRANSPORTS: z
    .string()
    .default('websocket,polling')
    .transform((value) =>
      value
        .split(',')
        .map((transport) => transport.trim())
        .filter((transport): transport is 'websocket' | 'polling' =>
          transport === 'websocket' || transport === 'polling',
        ),
    ),
  /**
   * A phone on a mobile network reconnects constantly. Writing `lastSeenAt` on
   * every one of those would be a write per reconnect per pro; the matching
   * grace window is measured in minutes, so this resolution is ample.
   */
  PRESENCE_SEEN_THROTTLE_SECONDS: z.coerce.number().int().nonnegative().default(120),
  /** 0 turns the admin dashboard cache off. */
  STATS_CACHE_SECONDS: z.coerce.number().int().nonnegative().default(30),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/** Read on every call rather than captured once, so the switch is a single env var. */
export const paymentsEnabled = (): boolean => env.ORDER_ACCEPT_FEE > 0;

export type Env = typeof env;
