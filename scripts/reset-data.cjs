/* Maintenance only. Dry-run by default; never expose this as an API route. */
const fs = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

async function main() {
  const config = dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
  const uri = config.MONGO_URI;
  if (!uri) throw new Error('Mongo configuration missing');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, socketTimeoutMS: 30000 });
  try {
    await client.connect();
    const db = client.db();
    if (db.databaseName !== 'ustauz') throw new Error('Refusing a database other than ustauz');
    const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((entry) => entry.name).filter((name) => !name.startsWith('system.')).sort();
    const counts = {};
    for (const name of collections) counts[name] = await db.collection(name).countDocuments();
    const product = collections.includes('products')
      ? await db.collection('products').findOne({ isActive: true }, { projection: { _id: 1 } }) : null;
    console.log(JSON.stringify({ database: db.databaseName, counts,
      publicProductId: product ? String(product._id) : null, execute: process.argv.includes('--execute') }));
    if (!process.argv.includes('--execute')) return;
    if (!process.argv.includes('--database=ustauz')) throw new Error('Explicit database argument required');
    // Preserve schemas/indexes and service configuration; remove every data document.
    for (const name of collections) await db.collection(name).deleteMany({});
    const remaining = {};
    for (const name of collections) remaining[name] = await db.collection(name).countDocuments();
    console.log(JSON.stringify({ remaining }));
    if (Object.values(remaining).some((count) => count !== 0)) throw new Error('New data arrived during cleanup');
  } finally {
    await client.close();
  }
}
main().catch((error) => {
  // Never print a connection string or provider credential from a driver error.
  console.error(JSON.stringify({ failed: true, errorName: error.name, code: error.code ?? null }));
  process.exitCode = 1;
});
