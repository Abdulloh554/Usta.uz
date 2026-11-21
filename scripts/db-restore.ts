/* eslint-disable no-console */
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { restoreDatabase } from '../src/maintenance/backup';
import { describeUri } from './db-backup';

/**
 * Puts a backup made by `npm run db:backup` back into a database.
 *
 *   npm run db:restore -- backups/ustauz-2026-11-21T15-04-05Z            # check only
 *   npm run db:restore -- backups/ustauz-2026-11-21T15-04-05Z --execute  # restore
 *
 * The target is RESTORE_URI if set, otherwise MONGO_URI from server/.env. Without
 * --execute it verifies every file's checksum and the target, and writes nothing.
 * It only ever writes into empty collections: if the target holds any data in a
 * collection the backup contains, it stops before touching anything. To restore
 * over a damaged database, restore into a new, empty one and point the API at it.
 */

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const main = async (): Promise<void> => {
  const dirArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  if (!dirArg) throw new Error('Usage: npm run db:restore -- <backup folder> [--execute]');
  const dir = path.resolve(dirArg);
  const execute = process.argv.includes('--execute');

  const uri = process.env.RESTORE_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('Set RESTORE_URI or MONGO_URI (server/.env)');

  const client = new mongoose.mongo.MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  try {
    const db = client.db();
    console.log(`${execute ? 'Restoring' : 'Checking'} ${dir} → ${describeUri(uri)}`);
    const plan = await restoreDatabase(db, dir, { execute });

    console.log(`Backup of "${plan.backupOf}" taken ${plan.backupCreatedAt}; checksums OK.`);
    for (const entry of plan.collections) {
      console.log(`  ${entry.name.padEnd(24)} ${String(entry.documents).padStart(8)} documents`);
    }
    if (!plan.executed) {
      console.log('Target collections are empty. Nothing written; add --execute to restore.');
      return;
    }
    console.log('Restored. Every collection holds exactly the documents in the backup.');
    if (plan.indexErrors.length) {
      console.log('Some indexes could not be rebuilt — run `npm run indexes:sync`:');
      for (const failure of plan.indexErrors) {
        console.log(`  ${failure.collection}.${failure.index}: ${failure.error}`);
      }
    }
  } finally {
    await client.close();
  }
};

main().catch((error: Error) => {
  console.error(
    `Restore failed: ${error.name}${error.message.includes('mongodb') ? '' : `: ${error.message}`}`,
  );
  process.exitCode = 1;
});
