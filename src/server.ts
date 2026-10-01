import cluster from 'node:cluster';
import http from 'node:http';
import os from 'node:os';
// Sentry must be initialised before the app is constructed so that a failure
// during boot is still reported.
import { initSentry } from './config/sentry';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { beginShutdown } from './config/lifecycle';
import { connectDatabase, disconnectDatabase } from './config/database';
import { connectRedis, disconnectRedis } from './config/redis';
import { initSocketServer } from './sockets';
import { startWorkers, stopWorkers } from './jobs';

initSentry();

/**
 * Node runs one thread, so a single process uses one core however many the host
 * has. Workers share the listening socket, and everything that has to be shared
 * between them already lives outside the process — sessions and rate-limit
 * counters in Redis, socket fan-out through the Redis adapter, job state in
 * BullMQ — so adding workers needs no other change.
 */
const workerCount = (): number => {
  if (env.CLUSTER_WORKERS > 0) return env.CLUSTER_WORKERS;
  return typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
};

const start = async (): Promise<void> => {
  await Promise.all([connectDatabase(), connectRedis()]);

  const app = createApp();
  const server = http.createServer(app);

  /**
   * Node closes an idle keep-alive connection after 5 seconds by default. When
   * a proxy in front holds its own connection open for longer, it can send a
   * request into one the server is closing at that moment and the client sees a
   * 502 it cannot explain. The fix is for the server to outlast the proxy.
   */
  server.keepAliveTimeout = env.KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = env.KEEP_ALIVE_TIMEOUT_MS + 1_000;
  if (env.REQUEST_TIMEOUT_MS > 0) server.requestTimeout = env.REQUEST_TIMEOUT_MS;

  const io = initSocketServer(server);
  await startWorkers();

  server.listen(env.PORT, () => {
    logger.info(`Usta.uz API listening on port ${env.PORT}`, {
      env: env.NODE_ENV,
      prefix: env.API_PREFIX,
      pid: process.pid,
    });
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (!beginShutdown()) return;
    logger.info(`${signal} received — shutting down`, { pid: process.pid });

    // Nothing may outlast this. A drain that hangs holds the deploy open until
    // the platform sends SIGKILL, which is the one exit that drops in-flight
    // work — so the deadline is enforced here instead.
    const forced = setTimeout(() => {
      logger.error('Shutdown timed out — forcing exit', { timeoutMs: env.SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forced.unref();

    // `close` stops new connections and calls back once the open ones end. Web
    // sockets never end on their own, so without disconnecting them the
    // callback would never fire at all.
    const closed = new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    /**
     * `local` is essential. Through the Redis adapter, a plain
     * `io.disconnectSockets()` reaches every instance in the cluster — so one
     * replica draining during a rolling deploy would sign every user out
     * everywhere. This disconnects only the sockets held by this process,
     * which is what lets `server.close` finish: web sockets never end on
     * their own, and the callback above waits for all of them.
     */
    io.local.disconnectSockets(true);
    await closed;

    // Workers first: let an in-flight offer timeout finish before Redis closes.
    await stopWorkers();
    await Promise.allSettled([disconnectDatabase(), disconnectRedis()]);
    clearTimeout(forced);
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

const workers = workerCount();

if (workers > 1 && cluster.isPrimary) {
  logger.info('Starting cluster', { workers, pid: process.pid });

  for (let index = 0; index < workers; index += 1) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    // A worker that dies while the primary is alive is replaced: one crash must
    // not quietly reduce capacity for the rest of the deployment's life.
    logger.error('Worker exited — replacing it', { pid: worker.process.pid, code, signal });
    cluster.fork();
  });

  (['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
    process.on(signal, () => {
      logger.info(`${signal} received — stopping workers`);
      Object.values(cluster.workers ?? {}).forEach((worker) => worker?.kill(signal));
    });
  });
} else {
  void start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to start the server', { message });
    process.exit(1);
  });
}
