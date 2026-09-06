import http from 'node:http';
// Sentry must be initialised before the app is constructed so that a failure
// during boot is still reported.
import { initSentry } from './config/sentry';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectDatabase, disconnectDatabase } from './config/database';
import { connectRedis, disconnectRedis } from './config/redis';
import { initSocketServer } from './sockets';
import { startWorkers, stopWorkers } from './jobs';

initSentry();

const start = async (): Promise<void> => {
  await Promise.all([connectDatabase(), connectRedis()]);

  const app = createApp();
  const server = http.createServer(app);

  initSocketServer(server);
  await startWorkers();

  server.listen(env.PORT, () => {
    logger.info(`Usta.uz API listening on port ${env.PORT}`, {
      env: env.NODE_ENV,
      prefix: env.API_PREFIX,
    });
  });

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down`);

    // Stop accepting connections first, then drain the backing services, so an
    // in-flight request still has a working database while it finishes.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Workers first: let an in-flight offer timeout finish before Redis closes.
    await stopWorkers();
    await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
    logger.info('Shutdown complete');
    process.exit(0);
  };

  (['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
    process.on(signal, () => {
      void shutdown(signal);
    });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason: String(reason) });
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught exception — exiting', { message: error.message, stack: error.stack });
    process.exit(1);
  });
};

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('Failed to start the server', { message });
  process.exit(1);
});
