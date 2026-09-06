/* eslint-disable no-console */
import path from 'node:path';
import fs from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * Starts the API against a locally-managed MongoDB, for machines with neither
 * Docker nor a `mongod` service installed.
 *
 * `mongodb-memory-server` downloads and caches a real MongoDB binary, so this is
 * the genuine database, not a stub — and it is launched as a single-node replica
 * set because the job-acceptance path uses a multi-document transaction, which
 * a standalone server refuses.
 *
 * Data is written to `.mongo-data/` and kept between runs, so accounts created
 * during development survive a restart.
 */
const DB_PATH = path.resolve(__dirname, '..', '.mongo-data');

const start = async (): Promise<void> => {
  fs.mkdirSync(DB_PATH, { recursive: true });

  console.log('Starting MongoDB (single-node replica set)…');

  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger', dbName: 'ustauz' },
    instanceOpts: [{ port: 27017, dbPath: DB_PATH, storageEngine: 'wiredTiger' }],
  });

  const uri = replSet.getUri('ustauz');
  process.env.MONGO_URI = `${uri}${uri.includes('?') ? '&' : '?'}directConnection=true`;

  console.log(`MongoDB ready at ${process.env.MONGO_URI}`);
  console.log(`Data directory: ${DB_PATH}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} — stopping MongoDB…`);
    // Keep the files: this is a development database, not a test fixture.
    await replSet.stop({ doCleanup: false, force: false });
    process.exit(0);
  };

  (['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
    process.on(signal, () => {
      void shutdown(signal);
    });
  });

  // Imported only now, so `MONGO_URI` is already in the environment when
  // `config/env` parses it.
  await import('../src/server');
};

void start().catch((error: unknown) => {
  console.error('Could not start the development database:', error);
  process.exit(1);
});
