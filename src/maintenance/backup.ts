/* eslint-disable no-restricted-syntax, no-await-in-loop --
 * Backup and restore stream one collection, and one batch, at a time on
 * purpose: running them in parallel would hold whole collections in memory.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import mongoose from 'mongoose';

/**
 * Whole-database backup and restore, driven by `scripts/db-backup.ts` and
 * `scripts/db-restore.ts`.
 *
 * Each collection becomes one gzipped file with one document per line in
 * canonical Extended JSON, which keeps every BSON type exact — an ObjectId stays
 * an ObjectId, a Date a Date, a 64-bit integer is not rounded through a double.
 * A restored database is therefore the same data, not an approximation of it.
 * Indexes (TTL, text, 2dsphere, partial, sparse, unique) are recorded with
 * their options and rebuilt after the data is in.
 *
 * Restore never deletes or overwrites anything: it refuses a target where any
 * of the collections already holds a document.
 */

type Db = mongoose.mongo.Db;
type IndexDescription = mongoose.mongo.IndexDescriptionInfo;

const { EJSON } = mongoose.mongo.BSON;

export const BACKUP_FORMAT = 'ustauz-backup';
export const BACKUP_VERSION = 1;
const INSERT_BATCH = 1000;

export type CollectionEntry = {
  name: string;
  file: string;
  count: number;
  sha256: string;
  indexes: IndexDescription[];
};

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  database: string;
  createdAt: string;
  collections: CollectionEntry[];
};

export type RestorePlan = {
  database: string;
  backupOf: string;
  backupCreatedAt: string;
  collections: { name: string; documents: number }[];
  executed: boolean;
  indexErrors: { collection: string; index: string; error: string }[];
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
};

const userCollections = async (db: Db): Promise<string[]> =>
  (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('system.'))
    .sort();

/** Writes every collection of `db` into `dir`, which must not exist yet. */
export const backupDatabase = async (db: Db, dir: string): Promise<BackupManifest> => {
  if (fs.existsSync(dir)) throw new Error(`Refusing to write into existing folder ${dir}`);
  fs.mkdirSync(dir, { recursive: true });

  const collections: CollectionEntry[] = [];
  for (const name of await userCollections(db)) {
    const collection = db.collection(name);
    const file = `${name}.ejson.gz`;
    const target = path.join(dir, file);
    let count = 0;
    await pipeline(
      Readable.from(
        (async function* lines() {
          for await (const doc of collection.find({}, { batchSize: INSERT_BATCH })) {
            count += 1;
            yield `${EJSON.stringify(doc, { relaxed: false })}\n`;
          }
        })(),
      ),
      zlib.createGzip(),
      fs.createWriteStream(target),
    );

    collections.push({
      name,
      file,
      count,
      sha256: await sha256File(target),
      indexes: (await collection.indexes()).filter((index) => index.name !== '_id_'),
    });
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    database: db.databaseName,
    createdAt: new Date().toISOString(),
    collections,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

export const readManifest = (dir: string): BackupManifest => {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`No manifest.json in ${dir}`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT || manifest.version !== BACKUP_VERSION) {
    throw new Error(`${dir} is not a ${BACKUP_FORMAT} v${BACKUP_VERSION} backup`);
  }
  return manifest;
};

/** Checks every file against the checksum recorded when it was written. */
export const verifyBackup = async (dir: string): Promise<BackupManifest> => {
  const manifest = readManifest(dir);
  for (const entry of manifest.collections) {
    const file = path.join(dir, entry.file);
    if (!fs.existsSync(file)) throw new Error(`Missing ${entry.file}`);
    if ((await sha256File(file)) !== entry.sha256) {
      throw new Error(`${entry.file} does not match its checksum; the backup is damaged`);
    }
  }
  return manifest;
};

const insertFile = async (db: Db, dir: string, entry: CollectionEntry): Promise<number> => {
  const collection = db.collection(entry.name);
  const lines = readline.createInterface({
    input: fs.createReadStream(path.join(dir, entry.file)).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  let batch: mongoose.mongo.Document[] = [];
  let inserted = 0;
  for await (const line of lines) {
    if (line) {
      batch.push(EJSON.parse(line, { relaxed: false }) as mongoose.mongo.Document);
      if (batch.length === INSERT_BATCH) {
        inserted += (await collection.insertMany(batch, { ordered: true })).insertedCount;
        batch = [];
      }
    }
  }
  if (batch.length)
    inserted += (await collection.insertMany(batch, { ordered: true })).insertedCount;
  return inserted;
};

/**
 * Restores `dir` into `db`. Without `execute` it only verifies the backup and
 * the target and reports what it would do.
 */
export const restoreDatabase = async (
  db: Db,
  dir: string,
  { execute }: { execute: boolean },
): Promise<RestorePlan> => {
  const manifest = await verifyBackup(dir);

  const occupied: string[] = [];
  for (const entry of manifest.collections) {
    if ((await db.collection(entry.name).countDocuments({}, { limit: 1 })) > 0) {
      occupied.push(entry.name);
    }
  }
  if (occupied.length) {
    throw new Error(
      `Target database "${db.databaseName}" already has data in: ${occupied.join(', ')}. ` +
        'Restore only writes into empty collections and never overwrites.',
    );
  }

  const plan: RestorePlan = {
    database: db.databaseName,
    backupOf: manifest.database,
    backupCreatedAt: manifest.createdAt,
    collections: manifest.collections.map(({ name, count }) => ({ name, documents: count })),
    executed: false,
    indexErrors: [],
  };
  if (!execute) return plan;

  for (const entry of manifest.collections) {
    const inserted = await insertFile(db, dir, entry);
    if (inserted !== entry.count) {
      throw new Error(`${entry.name}: restored ${inserted} documents, backup holds ${entry.count}`);
    }
  }

  // Indexes go in after the data: one build per index instead of an update per
  // insert. A failure is reported rather than fatal — the data is already safe,
  // and `npm run indexes:sync` rebuilds every index the schemas declare.
  for (const entry of manifest.collections) {
    const collection = db.collection(entry.name);
    // Make sure an empty collection still exists, with its indexes.
    if (entry.count === 0) await db.createCollection(entry.name).catch(() => undefined);
    for (const index of entry.indexes) {
      // `v` and `ns` describe the old index, not options for a new one.
      const { key, ...options } = { ...index } as IndexDescription & { ns?: string };
      delete options.v;
      delete options.ns;
      try {
        await collection.createIndex(key as mongoose.mongo.IndexSpecification, options);
      } catch (error) {
        plan.indexErrors.push({
          collection: entry.name,
          index: index.name ?? JSON.stringify(key),
          error: (error as Error).message,
        });
      }
    }
  }

  plan.executed = true;
  return plan;
};
