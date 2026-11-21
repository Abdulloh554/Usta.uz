/* eslint-disable no-console */
import path from 'node:path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { backupDatabase, pruneBackups } from '../src/maintenance/backup';

/**
 * Copies the whole database to a local folder. Read-only: it never writes to
 * the database.
 *
 *   npm run db:backup                    # → backups/ustauz-2026-11-21T15-04-05Z/
 *   npm run db:backup -- --out D:/safe   # → D:/safe/ustauz-2026-…/
 *   npm run db:backup -- --keep 14       # then delete all but the newest 14
 *
 * Connects with MONGO_URI from server/.env (or the environment). The folder
 * holds every user's personal data in the clear: keep it off GitHub (backups/
 * is git-ignored) and somewhere only you can open.
 */

dotenv.config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

/** `mongodb://user:pass@host/db` → `host/db`, so no credential is ever printed. */
export const describeUri = (uri: string): string =>
  uri.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, '').replace(/\?.*$/, '');

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = async (): Promise<void> => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set (server/.env)');

  const client = new mongoose.mongo.MongoClient(uri, {
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 15_000,
  });
  await client.connect();
  try {
    const db = client.db();
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/-\d{3}Z$/, 'Z');
    const root = path.resolve(argValue('--out') ?? path.resolve(__dirname, '..', 'backups'));
    const dir = path.join(root, `${db.databaseName}-${stamp}`);

    console.log(`Backing up ${describeUri(uri)} → ${dir}`);
    const manifest = await backupDatabase(db, dir);
    const total = manifest.collections.reduce((sum, entry) => sum + entry.count, 0);
    for (const entry of manifest.collections) {
      console.log(`  ${entry.name.padEnd(24)} ${String(entry.count).padStart(8)} documents`);
    }
    console.log(`Done: ${manifest.collections.length} collections, ${total} documents.`);

    // Pruning runs only after this backup is complete, so the newest copy is
    // always the one just written.
    const keep = argValue('--keep');
    if (keep !== undefined) {
      const removed = pruneBackups(root, db.databaseName, Number(keep));
      console.log(`Kept the newest ${keep}; removed ${removed.length} older backup(s).`);
    }
  } finally {
    await client.close();
  }
};

if (require.main === module) {
  main().catch((error: Error) => {
    // Driver errors can quote the connection string; print the type and our own message only.
    console.error(
      `Backup failed: ${error.name}${error.message.includes('mongodb') ? '' : `: ${error.message}`}`,
    );
    process.exitCode = 1;
  });
}
