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
import { isShuttingDown } from './config/lifecycle';
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
    app.use(
      morgan(isProduction ? 'combined' : 'dev', {
        stream: httpLogStream,
        // Probes run every few seconds forever; logging them buries the traffic
        // that actually happened and costs a write per probe.
        skip: (req) => req.url.startsWith('/health'),
      }),
    );
  }

  const backingServices = () => ({
    mongo: mongoose.connection.readyState === 1 ? 'up' : 'down',
    redis: redis.status === 'ready' ? 'up' : redis.status,
  });

  /**
   * Liveness. Answers for the process alone, so a shared Mongo or Redis blip
   * cannot make every instance look dead at once and have them all restarted —
   * which turns a recoverable dependency outage into a total one.
   */
  app.get('/health', (_req, res) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        ...backingServices(),
        env: env.NODE_ENV,
      },
    });
  });

  /**
   * Readiness. Answers whether *this* instance can serve a request right now,
   * so a replica that is still connecting, has lost a backing service, or is
   * draining for a deploy is taken out of the load balancer instead of being
   * handed traffic it will fail.
   */
  app.get('/health/ready', (_req, res) => {
    const services = backingServices();
    const ready = services.mongo === 'up' && services.redis === 'up' && !isShuttingDown();

    res.status(ready ? 200 : 503).json({
      success: ready,
      data: {
        status: ready ? 'ready' : 'unavailable',
        draining: isShuttingDown(),
        ...services,
      },
    });
  });

  app.use(env.API_PREFIX, globalLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
