import mongoose from 'mongoose';
import { env, isProduction } from './env';
import { logger } from './logger';

mongoose.set('strictQuery', true);
/**
 * `sanitizeFilter` is deliberately left off. It escapes every `$` operator in a
 * filter, including the ones the application writes itself — the conditional
 * `{ balance: { $gte: fee } }` guard in the accept path becomes a literal match
 * and silently stops protecting anything. Untrusted input is sanitised at the
 * HTTP boundary by `express-mongo-sanitize`, which is the correct layer.
 */

if (!isProduction) {
  mongoose.set('debug', false);
}

let connecting: Promise<typeof mongoose> | null = null;

export const connectDatabase = async (uri: string = env.MONGO_URI): Promise<typeof mongoose> => {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;

  connecting = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 20,
      minPoolSize: 2,
      retryWrites: true,
    })
    .then((instance) => {
      logger.info('MongoDB connected', { host: instance.connection.host, db: instance.connection.name });
      return instance;
    })
    .catch((error: unknown) => {
      connecting = null;
      throw error;
    });

  return connecting;
};

export const disconnectDatabase = async (): Promise<void> => {
  connecting = null;
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  logger.info('MongoDB disconnected');
};

mongoose.connection.on('error', (error: Error) => {
  logger.error('MongoDB connection error', { message: error.message });
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

/**
 * Matching relies on multi-document transactions to stop two pros accepting the
 * same job. Those need a replica set; a standalone mongod rejects the session,
 * so callers use this to fall back to a guarded single-document update.
 */
export const supportsTransactions = (): boolean => {
  const client = mongoose.connection.getClient();
  // `topology` is not on the public typings but is the only reliable signal.
  const {topology} = (client as unknown as { topology?: { s?: { description?: { type?: string } } } });
  const type = topology?.s?.description?.type;
  return type === 'ReplicaSetWithPrimary' || type === 'Sharded';
};
