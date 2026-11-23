import { env, isProduction } from './env';
import { logger } from './logger';

/**
 * Calls the service's own public `/health` on a timer, so a free Render
 * instance never sits 15 minutes without an incoming request and goes to
 * sleep. Production only; returns the timer, or `null` when it is off.
 */
export const startKeepAwake = (
  url: string = env.SELF_PING_URL,
  minutes: number = env.SELF_PING_MINUTES,
  enabled: boolean = isProduction,
): NodeJS.Timeout | null => {
  const base = url.trim().replace(/\/+$/, '');
  if (!enabled || !base || minutes <= 0) return null;

  const target = `${base}/health`;
  const timer = setInterval(() => {
    fetch(target, { signal: AbortSignal.timeout(30_000) }).catch((error: unknown) => {
      logger.warn('Keep-awake ping failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, minutes * 60_000);
  // A pending ping must never hold the process open during shutdown.
  timer.unref();

  logger.info('Keep-awake ping on', { target, minutes });
  return timer;
};
