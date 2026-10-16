import request from 'supertest';
import { createApp } from '../../src/app';
import { Craft, OrderCategory, OrderStatus, UserRole } from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { Order } from '../../src/modules/order/order.model';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { buildCandidates } from '../../src/modules/matching/matching.service';
import { makeClient, makeMaster } from '../helpers/factories';

const app = createApp();
const token = (id: string, role: UserRole) => `Bearer ${issueTokenPair(id, role).accessToken}`;
const draft = {
  title: 'Suv oqyapti',
  description: 'Oshxonadagi quvurdan suv oqyapti.',
  category: OrderCategory.PLUMBING,
  address: 'Toshkent, Chilonzor, 12-uy, 4-xonadon',
  landmark: 'Maktab yonida, ko‘k darvoza',
};

describe('job address', () => {
  it.each([undefined, [69.24, 41.3]])(
    'saves address and landmark with optional GPS %j',
    async (location) => {
      const client = await makeClient();
      const response = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', token(client.id as string, UserRole.CLIENT))
        .send({ ...draft, location });
      expect(response.status).toBe(201);
      const saved = await Order.findById(response.body.data.id).orFail();
      expect(saved.address).toBe(draft.address);
      expect(saved.landmark).toBe(draft.landmark);
      if (location) expect(saved.location?.coordinates).toEqual(location);
    },
  );

  it('hides exact address from the feed and offered masters until acceptance', async () => {
    const client = await makeClient();
    const master = await makeMaster({ crafts: [Craft.PLUMBER] });
    const other = await makeMaster({ crafts: [Craft.PLUMBER] });
    const order = await Order.create({
      ...draft,
      client: client._id,
      code: 'ADDR01',
      location: { type: 'Point', coordinates: [69.24, 41.3] },
      offers: [{ master: master._id }, { master: other._id }],
      status: OrderStatus.MATCHING,
    });
    const masterAuth = token(master.id as string, UserRole.MASTER);
    const feed = await request(app).get('/api/v1/orders/feed').set('Authorization', masterAuth);
    expect(feed.status).toBe(200);
    expect(feed.body.data.items[0]).not.toHaveProperty('address');
    expect(feed.body.data.items[0]).not.toHaveProperty('landmark');
    expect(feed.body.data.items[0]).not.toHaveProperty('location');
    const offered = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', masterAuth);
    expect(offered.status).toBe(200);
    expect(offered.body.data).not.toHaveProperty('address');
    expect(offered.body.data).not.toHaveProperty('location');
    const owner = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', token(client.id as string, UserRole.CLIENT));
    expect(owner.body.data.landmark).toBe(draft.landmark);
    await Order.updateOne({ _id: order._id }, { master: master._id, status: OrderStatus.ACCEPTED });
    const accepted = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', masterAuth);
    expect(accepted.body.data.address).toBe(draft.address);
    expect(accepted.body.data.landmark).toBe(draft.landmark);
    expect(accepted.body.data.location.coordinates).toEqual([69.24, 41.3]);
    const notAssigned = await request(app)
      .get(`/api/v1/orders/${order.id}`)
      .set('Authorization', token(other.id as string, UserRole.MASTER));
    expect(notAssigned.body.data).not.toHaveProperty('address');
    expect(notAssigned.body.data).not.toHaveProperty('landmark');
  });

  it('keeps unlocated legacy masters eligible for GPS jobs, without claiming a distance', async () => {
    const client = await makeClient();
    const unlocated = await makeMaster({ crafts: [Craft.PLUMBER] });
    const far = await makeMaster({ crafts: [Craft.PLUMBER] });
    await MasterProfile.updateOne(
      { user: far._id },
      { location: { type: 'Point', coordinates: [60, 40] } },
    );
    const order = await Order.create({
      ...draft,
      client: client._id,
      code: 'ADDR02',
      location: { type: 'Point', coordinates: [69.24, 41.3] },
    });
    const candidates = await buildCandidates(order);
    expect(candidates.map((item) => item.masterId)).toEqual([unlocated.id]);
    expect(candidates[0]?.distanceKm).toBeNull();
  });

  it.each([{ landmark: 'a'.repeat(301) }, { location: [69, 91] }, { location: [181, 41] }])(
    'rejects invalid address data %#',
    async (invalid) => {
      const client = await makeClient();
      const response = await request(app)
        .post('/api/v1/orders')
        .set('Authorization', token(client.id as string, UserRole.CLIENT))
        .send({ ...draft, ...invalid });
      expect(response.status).toBe(422);
    },
  );
});
