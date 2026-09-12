import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the process reads passes through this schema.
 * A malformed value fails the boot rather than surfacing as a runtime error
 * hours later, so `env` is safe to treat as fully typed everywhere else.
 */
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

  MONGO_URI: z.string().min(1),

  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

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

  MATCH_OFFER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(45),
  MATCH_MAX_CANDIDATES: z.coerce.number().int().positive().default(20),
  MATCH_RADIUS_KM: z.coerce.number().positive().default(15),

  SENTRY_DSN: z.string().default(''),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
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
