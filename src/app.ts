import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import mongoose from 'mongoose';
import { env, isProduction, isTest } from './config/env';
import { httpLogStream } from './config/logger';
import { redis } from './config/redis';
import { apiRouter } from './routes';
import { errorHandler, notFoundHandler } from './common/middlewares/error.middleware';
import { globalLimiter } from './common/middlewares/rateLimit.middleware';

export const createApp = (): Express => {
  const app = express();

  // Behind a load balancer, this is what makes `req.ip` — and therefore rate
  // limiting — see the real client rather than the proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, callback) => {
        // Native apps and server-to-server calls send no Origin header.
        if (!origin || env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  // Strips `$` and `.` from user input so a crafted body cannot reshape a query.
  app.use(mongoSanitize({ replaceWith: '_' }));

  if (!isTest) {
    app.use(morgan(isProduction ? 'combined' : 'dev', { stream: httpLogStream }));
  }

  app.get('/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        mongo: mongoose.connection.readyState === 1 ? 'up' : 'down',
        redis: redis.status === 'ready' ? 'up' : redis.status,
        env: env.NODE_ENV,
      },
    });
  });

  app.use(env.API_PREFIX, globalLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
