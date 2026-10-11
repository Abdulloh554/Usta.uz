import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { Order } from '../../src/modules/order/order.model';
import { createOrder } from '../../src/modules/order/order.service';
import { startMatching, expireOffer } from '../../src/modules/matching/matching.service';
import { deleteIfValue } from '../../src/common/utils/redisAtomic';
import { keys } from '../../src/config/redis';
import { fakeRedis } from '../helpers/redisMock';
import { makeClient, makeMaster, makeOrder, nextPhone } from '../helpers/factories';
import { OrderCategory, OrderStatus, UserRole } from '../../src/common/types';
import { User } from '../../src/modules/user/user.model';
import { Notification } from '../../src/modules/notification/notification.model';
import { Broadcast } from '../../src/modules/admin/broadcast.model';
import { queueBroadcast, processBroadcastBatch } from '../../src/modules/admin/broadcast.service';
import { issueTokenPair } from '../../src/common/utils/token';
import { Visit } from '../../src/modules/traffic/traffic.model';
import { trafficReport } from '../../src/modules/traffic/traffic.service';

describe('capacity and concurrency regressions', () => {
  it('creates exactly one waiting job for eight simultaneous submissions', async () => {
    const client = await makeClient();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        createOrder(String(client._id), {
          title: 'Elektrik kerak',
          description: 'Uyda elektr simini tekshirish kerak',
          category: OrderCategory.ELECTRICAL,
          photos: [],
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await Order.countDocuments({ client: client._id })).toBe(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason.code).toBe('ACTIVE_ORDER_EXISTS');
  });

  it('reserves one pro for only one of two simultaneous matching runs', async () => {
    const master = await makeMaster();
    const clients = await Promise.all([makeClient(), makeClient()]);
    const orders = await Promise.all(clients.map((client) => makeOrder(client._id)));
    const results = await Promise.all(orders.map((order) => startMatching(String(order._id))));
    expect(results.filter((result) => result.current === String(master._id))).toHaveLength(1);
    const selected = await fakeRedis.get(keys.masterOffer(String(master._id)));
    expect(selected).toBe(results.find((result) => result.current)?.orderId);
    expect(await Order.countDocuments({ status: OrderStatus.MATCHING })).toBe(1);
  });

  it('never deletes a reservation that another job now owns', async () => {
    await fakeRedis.set('lease', 'new-owner', 'EX', 45);
    expect(await deleteIfValue('lease', 'old-owner')).toBe(0);
    expect(await fakeRedis.get('lease')).toBe('new-owner');
    expect(await deleteIfValue('lease', 'new-owner')).toBe(1);
  });

  it('only advances a timed-out offer once when two workers race', async () => {
    const client = await makeClient();
    await makeMaster({ rating: 5 });
    await makeMaster({ rating: 4 });
    const order = await makeOrder(client._id);
    const first = await startMatching(String(order._id));
    const result = await Promise.all([
      expireOffer(String(order._id), first.current!),
      expireOffer(String(order._id), first.current!),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    expect((await Order.findById(order._id))?.offers).toHaveLength(2);
  });

  it('resumes a broadcast from its committed batch without duplicates across workers', async () => {
    const admin = await User.create({
      phone: nextPhone(),
      passwordHash: 'secret123',
      firstName: 'Bosh',
      lastName: 'Admin',
      role: UserRole.ADMIN,
    });
    await User.insertMany(
      Array.from({ length: 503 }, () => ({
        phone: nextPhone(),
        passwordHash: 'fixture-hash',
        firstName: 'Test',
        lastName: 'Client',
        role: UserRole.CLIENT,
      })),
    );
    const result = await queueBroadcast(String(admin._id), {
      audience: 'client',
      title: 'Yangilik',
      body: 'Yangi imkoniyatlar',
    });
    expect(result).toMatchObject({ status: 'queued', delivered: 0, recipients: 503 });
    await Promise.all([processBroadcastBatch(), processBroadcastBatch()]);
    const { delivered } = (await Broadcast.findById(result.jobId))!;
    expect(delivered).toBeGreaterThanOrEqual(250);
    expect(delivered).toBeLessThanOrEqual(500);
    await processBroadcastBatch();
    await processBroadcastBatch();
    await processBroadcastBatch();
    const job = await Broadcast.findById(result.jobId);
    expect(job).toMatchObject({ status: 'completed', delivered: 503 });
    expect(await Notification.countDocuments()).toBe(503);
    const duplicates = await Notification.aggregate([
      { $group: { _id: '$user', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    expect(duplicates).toHaveLength(0);
    const app = createApp();
    await request(app).get(`/api/v1/admin/broadcasts/${result.jobId}`).expect(401);
    await request(app)
      .get(`/api/v1/admin/broadcasts/${result.jobId}`)
      .set(
        'Authorization',
        `Bearer ${issueTokenPair(String(admin._id), UserRole.ADMIN).accessToken}`,
      )
      .expect(200);
  });

  it('counts one browser across sites, sources, sessions and hours without set arrays', async () => {
    const visitorId = randomUUID();
    await Visit.insertMany(
      Array.from({ length: 1200 }, (_, i) => ({
        visitorId,
        sessionId: randomUUID(),
        site: i % 2 ? 'web' : 'landing',
        source: i % 3 ? 'google' : 'link',
        path: '/uz',
        createdAt: new Date(`2026-10-10T${String(i % 12).padStart(2, '0')}:00:00+05:00`),
      })),
    );
    const data = await trafficReport({ date: '2026-10-10', page: 1, limit: 30 });
    expect(data.totals).toEqual({ visits: 1200, visitors: 1 });
    expect(data.hours[0]).toMatchObject({ visits: 100, visitors: 1, link: 1 });
    expect(data.entries.total).toBe(1200);
    const filtered = await trafficReport({
      date: '2026-10-10',
      page: 1,
      limit: 30,
      site: 'web',
      source: 'google',
    });
    expect(filtered.totals).toEqual({ visits: 400, visitors: 1 });
  });
});
