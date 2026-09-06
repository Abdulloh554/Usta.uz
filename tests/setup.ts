import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { fakeRedis } from './helpers/redisMock';

/**
 * Redis and BullMQ are replaced wholesale. The suite is about the application's
 * own logic — matching order, race safety, validation — and standing up real
 * infrastructure for that would make the tests slow and flaky without testing
 * anything the libraries do not already guarantee.
 */
jest.mock('../src/config/redis', () => {
  const { fakeRedis: client } = jest.requireActual<typeof import('./helpers/redisMock')>(
    './helpers/redisMock',
  );
  const actual = jest.requireActual<typeof import('../src/config/redis')>('../src/config/redis');
  return {
    ...actual,
    redis: client,
    createQueueConnection: () => client,
    connectRedis: jest.fn().mockResolvedValue(undefined),
    disconnectRedis: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('../src/jobs/queues', () => {
  const actual = jest.requireActual<typeof import('../src/jobs/queues')>('../src/jobs/queues');
  return {
    ...actual,
    // Timeouts are triggered explicitly in the tests that care about them, so
    // nothing fires on a wall-clock delay mid-suite.
    scheduleOfferTimeout: jest.fn().mockResolvedValue(undefined),
    cancelOfferTimeout: jest.fn().mockResolvedValue(undefined),
    getMatchingQueue: jest.fn(),
    getNotificationQueue: jest.fn(() => ({ add: jest.fn().mockResolvedValue(undefined) })),
    closeQueues: jest.fn().mockResolvedValue(undefined),
  };
});

/**
 * An in-memory **replica set**, not a standalone server: the accept path uses a
 * multi-document transaction, and that needs one.
 */
let replSet: MongoMemoryReplSet | undefined;

jest.setTimeout(120_000);

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(replSet.getUri(), { directConnection: true });
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
  fakeRedis.flush();
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
