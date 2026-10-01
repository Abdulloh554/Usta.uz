/**
 * Brings every collection's indexes in line with the schemas, then exits.
 *
 * Mongoose builds indexes at boot by default, which is right for a small
 * database and wrong for a large one: the build competes with live traffic, and
 * a foreground build on an old server blocks writes. Setting `MONGO_AUTO_INDEX`
 * to `false` in production turns that off, and this script becomes the release
 * step that applies an index change deliberately instead.
 *
 *   npm run indexes:sync
 *
 * `syncIndexes` also drops indexes the schema no longer declares, so it is the
 * whole reconciliation and not just the additions.
 *
 * Two things this script does not take on trust:
 *
 *  - **Auto-indexing is forced off for this process.** Otherwise Mongoose starts
 *    building every model's indexes the moment the connection opens, and those
 *    builds race the explicit sync below — which can leave `syncIndexes` looking
 *    like it succeeded when the index was never created.
 *  - **The result is verified against the database.** A unique index can only be
 *    built if the existing rows already satisfy it, so the usual failure is a
 *    duplicate-key error naming real data that has to be cleaned up first. That
 *    must be reported loudly rather than resolving quietly, so after syncing,
 *    every index the schema declares is checked to actually exist.
 *
 * A failure on one collection does not stop the others: it is far more useful to
 * see every problem in one run than to fix them one deploy at a time.
 */

// Set before anything imports `config/env`, which reads it once at load.
process.env.MONGO_AUTO_INDEX = 'false';

/** The name MongoDB gives an index when the schema does not name it itself. */
const defaultIndexName = (fields: Record<string, unknown>): string =>
  Object.entries(fields)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join('_');

const run = async (): Promise<void> => {
  // Imported only now, so the environment above is already in place.
  const mongoose = (await import('mongoose')).default;
  const { connectDatabase, disconnectDatabase } = await import('../src/config/database');
  const { logger } = await import('../src/config/logger');

  // Importing the models is what registers them.
  await import('../src/modules/user/user.model');
  await import('../src/modules/user/masterProfile.model');
  await import('../src/modules/order/order.model');
  await import('../src/modules/chat/chat.model');
  await import('../src/modules/product/product.model');
  await import('../src/modules/review/review.model');
  await import('../src/modules/wallet/transaction.model');
  await import('../src/modules/notification/notification.model');
  await import('../src/modules/admin/adminLog.model');

  await connectDatabase();

  const names = mongoose.modelNames();
  logger.info('Synchronising indexes', { models: names.length });

  const failures: Array<{ model: string; problem: string }> = [];

  // One model at a time: running every build at once against one cluster is the
  // situation this script exists to avoid.
  for (const name of names) {
    const model = mongoose.model(name);

    try {
      // eslint-disable-next-line no-await-in-loop
      const dropped = await model.syncIndexes();

      // Verify rather than assume — see the note at the top of the file.
      // eslint-disable-next-line no-await-in-loop
      const actual = await model.collection.indexes();
      const present = new Set(actual.map((index: { name?: string }) => index.name));

      const missing = model.schema
        .indexes()
        .map(([fields, options]) => (options?.name as string | undefined) ?? defaultIndexName(fields))
        .filter((indexName) => !present.has(indexName));

      if (missing.length > 0) {
        failures.push({ model: name, problem: `not created: ${missing.join(', ')}` });
        logger.error(`  ${name} — INDEXES MISSING AFTER SYNC`, { missing });
      } else {
        logger.info(`  ${name}`, { dropped: dropped.length > 0 ? dropped : 'nothing' });
      }
    } catch (error: unknown) {
      const problem = error instanceof Error ? error.message : String(error);
      failures.push({ model: name, problem });
      logger.error(`  ${name} — FAILED`, { problem });
    }
  }

  await disconnectDatabase();

  if (failures.length > 0) {
    logger.error(`${failures.length} of ${names.length} collections are not in sync`, {
      failures,
    });
    process.exitCode = 1;
    return;
  }

  logger.info('Indexes are in sync');
};

void run().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Index sync failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
