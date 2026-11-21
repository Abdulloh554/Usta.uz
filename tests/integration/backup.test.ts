import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { backupDatabase, restoreDatabase, verifyBackup } from '../../src/maintenance/backup';
import { makeClient, makeMaster, makeOrder, makeSeller } from '../helpers/factories';
import { Order } from '../../src/modules/order/order.model';
import { Product } from '../../src/modules/product/product.model';
import { Notification } from '../../src/modules/notification/notification.model';
import { Review } from '../../src/modules/review/review.model';
import { Transaction } from '../../src/modules/wallet/transaction.model';
import { User } from '../../src/modules/user/user.model';
import { NotificationType } from '../../src/common/types';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';

const { EJSON, Long, Decimal128, Binary, ObjectId } = mongoose.mongo.BSON;

const source = () => mongoose.connection.db!;
const otherDb = (name: string) => mongoose.connection.getClient().db(name);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ustauz-backup-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every document of every collection, in a form where any type change shows. */
const snapshot = async (db: mongoose.mongo.Db) => {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((entry) => entry.name)
    .sort();
  const result: Record<string, { docs: string; indexes: string }> = {};
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    const docs = await db.collection(name).find().sort({ _id: 1 }).toArray();
    // eslint-disable-next-line no-await-in-loop
    const indexes = (await db.collection(name).indexes())
      .map(({ v: _v, ns: _ns, ...rest }: Record<string, unknown>) => rest)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    result[name] = {
      docs: EJSON.stringify(docs, { relaxed: false }),
      indexes: JSON.stringify(indexes),
    };
  }
  return result;
};

const seed = async () => {
  // Build every index the schemas declare: text, 2dsphere, TTL, partial, sparse.
  await Promise.all(
    [User, MasterProfile, Order, Product, Notification, Review, Transaction].map((model) =>
      model.syncIndexes(),
    ),
  );
  const client = await makeClient({ balance: 12_500 });
  await makeMaster();
  const seller = await makeSeller();
  const order = await makeOrder(client._id);
  await Order.updateOne(
    { _id: order._id },
    { location: { type: 'Point', coordinates: [69.2, 41.3] } },
  );
  await Product.create({ seller: seller._id, title: 'Perforator', price: 450_000 });
  await Notification.create({
    user: client._id,
    type: Object.values(NotificationType)[0],
    title: 'Salom',
    body: 'Xush kelibsiz',
  });

  // Types JSON would lose: 64-bit integers, decimals, binary, nested dates, nulls.
  await source()
    .collection('rawtypes')
    .insertOne({
      big: Long.fromString('9007199254740993'),
      money: Decimal128.fromString('12345.6789'),
      blob: new Binary(Buffer.from([0, 1, 2, 255])),
      nested: { at: new Date('2026-01-02T03:04:05.678Z'), ids: [new ObjectId(), null] },
      unicode: "O'zbekiston — Ўзбекистон 🇺🇿",
    });
};

describe('database backup and restore', () => {
  it('restores every document and index exactly as backed up', async () => {
    await seed();
    const before = await snapshot(source());

    const manifest = await backupDatabase(source(), path.join(tmp, 'b'));
    expect(manifest.collections.map((entry) => entry.name)).toEqual(Object.keys(before));

    const target = otherDb('restore_exact');
    const plan = await restoreDatabase(target, path.join(tmp, 'b'), { execute: true });

    expect(plan.executed).toBe(true);
    expect(plan.indexErrors).toEqual([]);
    expect(await snapshot(target)).toEqual(before);
    await target.dropDatabase();
  });

  it('checks without --execute and writes nothing', async () => {
    await seed();
    await backupDatabase(source(), path.join(tmp, 'b'));
    const target = otherDb('restore_dry');

    const plan = await restoreDatabase(target, path.join(tmp, 'b'), { execute: false });

    expect(plan.executed).toBe(false);
    expect(plan.collections.find((entry) => entry.name === 'users')?.documents).toBe(3);
    expect(await target.listCollections().toArray()).toEqual([]);
  });

  it('never writes into a database that already holds data', async () => {
    await seed();
    await backupDatabase(source(), path.join(tmp, 'b'));
    const before = await snapshot(source());

    await expect(restoreDatabase(source(), path.join(tmp, 'b'), { execute: true })).rejects.toThrow(
      /already has data/,
    );
    expect(await snapshot(source())).toEqual(before);
  });

  it('detects a damaged backup file before restoring anything', async () => {
    await seed();
    const dir = path.join(tmp, 'b');
    await backupDatabase(source(), dir);
    fs.appendFileSync(path.join(dir, 'users.ejson.gz'), 'x');

    await expect(verifyBackup(dir)).rejects.toThrow(/checksum/);
    const target = otherDb('restore_damaged');
    await expect(restoreDatabase(target, dir, { execute: true })).rejects.toThrow(/checksum/);
    expect(await target.listCollections().toArray()).toEqual([]);
  });

  it('refuses to write a backup over an existing folder', async () => {
    fs.mkdirSync(path.join(tmp, 'b'));
    await expect(backupDatabase(source(), path.join(tmp, 'b'))).rejects.toThrow(/existing folder/);
  });
});
