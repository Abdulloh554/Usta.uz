import winston from 'winston';
import { env, isProduction } from './env';

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const humanFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${String(ts)} ${level} ${String(stack ?? message)}${rest}`;
});

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: isProduction
    ? combine(timestamp(), errors({ stack: true }), json())
    : combine(colorize(), timestamp({ format: 'HH:mm:ss.SSS' }), errors({ stack: true }), humanFormat),
  transports: [new winston.transports.Console({ handleExceptions: true, handleRejections: true })],
  exitOnError: false,
  silent: env.NODE_ENV === 'test',
});

/** Morgan pipes its access log line through here so both share one sink. */
export const httpLogStream = {
  write: (message: string): void => {
    logger.http(message.trim());
  },
};
