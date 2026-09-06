import * as Sentry from '@sentry/node';
import { env, isProduction } from './env';
import { logger } from './logger';

/**
 * Error monitoring. Initialised before anything else so a crash during boot is
 * still reported; a missing DSN simply turns it into a no-op rather than an
 * error, which is what local and CI runs want.
 */
export const initSentry = (): void => {
  if (!env.SENTRY_DSN) {
    if (isProduction) logger.warn('SENTRY_DSN is not set — errors will not be reported');
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // A marketplace this size does not need every transaction; 10% is enough to
    // see a regression without paying for the full firehose.
    tracesSampleRate: isProduction ? 0.1 : 1,
    beforeSend(event) {
      // Tokens and cookies must never leave the cluster. Sentry's `beforeSend`
      // contract is to return a modified copy of the event it is handed.
      if (!event.request) return event;
      // `cookies` is destructured out precisely so it is dropped from the event.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { headers, cookies, ...request } = event.request;
      const safeHeaders = headers ? { ...headers } : undefined;
      if (safeHeaders) delete safeHeaders.authorization;
      return { ...event, request: { ...request, headers: safeHeaders } };
    },
  });

  logger.info('Sentry initialised', { environment: env.NODE_ENV });
};

export const captureError = (error: unknown, context?: Record<string, unknown>): void => {
  if (!env.SENTRY_DSN) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
};
