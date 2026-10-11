// Additive migration: never drops indexes or edits/deletes application data.
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
async function main() {
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;
    if (db.databaseName !== 'ustauz') throw new Error('Unexpected target database');
    const additions = [
      ['users', { isActive: 1, isBlocked: 1, role: 1, _id: 1 }],
      ['visits', { site: 1, source: 1, createdAt: -1 }],
      ['visits', { source: 1, createdAt: -1 }],
      ['visits', { site: 1, createdAt: -1 }],
      ['broadcasts', { status: 1, leaseUntil: 1, createdAt: 1 }],
    ];
    const created = [];
    for (const [collection, fields] of additions) {
      created.push({ collection, index: await db.collection(collection).createIndex(fields) });
    }
    const hello = await db.admin().command({ hello: 1 });
    console.log(JSON.stringify({ database: db.databaseName, transactions: Boolean(hello.setName || hello.msg === 'isdbgrid'), indexes: created }));
  } finally { await mongoose.disconnect(); }
}
main().catch((error) => { console.error('Index migration failed (' + error.name + '). Check credentials and database configuration.'); process.exitCode = 1; });
