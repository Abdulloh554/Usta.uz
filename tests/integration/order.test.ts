import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { Order } from '../../src/modules/order/order.model';
import { Review } from '../../src/modules/review/review.model';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { OrderCategory, OrderStatus, UserRole } from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { makeClient, makeMaster } from '../helpers/factories';

const PREFIX = '/api/v1';

const bearer = (id: string, role: UserRole): string =>
  `Bearer ${issueTokenPair(id, role).accessToken}`;

const newJob = {
  title: 'Laptop will not turn on',
  description: 'No light even with the charger plugged in, Chilonzor district.',
  category: OrderCategory.ELECTRONICS,
  region: 'Chilonzor',
};

describe('the job lifecycle', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it('posts a job, offers it to a pro, and lets them accept and complete it', async () => {
    const client = await makeClient();
    const master = await makeMaster({ balance: 50_000, crafts: ['computers'] as never });

    const clientAuth = bearer(client.id as string, UserRole.CLIENT);
    const masterAuth = bearer(master.id as string, UserRole.MASTER);

    /* — the client posts — */
    const posted = await request(app).post(`${PREFIX}/orders`).set('Authorization', clientAuth).send(newJob);

    expect(posted.status).toBe(201);
    expect(posted.body.data.code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    const orderId = posted.body.data.id as string;

    // Matching runs alongside the response; give it a beat to make the offer.
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    const offered = await Order.findById(orderId);
    expect(offered!.status).toBe(OrderStatus.MATCHING);
    expect(offered!.offers[0]!.master.toString()).toBe(master.id);

    /* — the pro accepts — */
    const accepted = await request(app)
      .post(`${PREFIX}/orders/${orderId}/accept`)
      .set('Authorization', masterAuth);

    expect(accepted.status).toBe(200);
    expect(accepted.body.data.fee).toBe(4999);
    expect(accepted.body.data.chatId).toEqual(expect.any(String));

    /* — they talk — */
    const chatId = accepted.body.data.chatId as string;
    const sent = await request(app)
      .post(`${PREFIX}/chats/${chatId}/messages`)
      .set('Authorization', masterAuth)
      .send({ text: 'Hello! I accepted the job, I will be there in 30 minutes.' });

    expect(sent.status).toBe(201);

    const messages = await request(app)
      .get(`${PREFIX}/chats/${chatId}/messages`)
      .set('Authorization', clientAuth);
    expect(messages.body.data.items).toHaveLength(1);

    /* — the pro marks it done — */
    const completed = await request(app)
      .post(`${PREFIX}/orders/${orderId}/complete`)
      .set('Authorization', masterAuth);

    expect(completed.status).toBe(200);
    expect(completed.body.data.status).toBe(OrderStatus.DONE);

    /* — the client rates — */
    const rated = await request(app)
      .post(`${PREFIX}/reviews/master`)
      .set('Authorization', clientAuth)
      .send({ orderId, stars: 5, comment: 'Arrived in 30 minutes and worked cleanly.' });

    expect(rated.status).toBe(201);

    const profile = await MasterProfile.findOne({ user: master._id });
    expect(profile!.completedJobs).toBe(1);
    // 10 seed reviews at 4.5 plus one at 5 → 4.5 average, rounded to one place.
    expect(profile!.rating).toBe(5);
    expect(profile!.ratingCount).toBe(1);
  });

  it('will not let a client post a second job while one is still searching', async () => {
    const client = await makeClient();
    const auth = bearer(client.id as string, UserRole.CLIENT);

    await request(app).post(`${PREFIX}/orders`).set('Authorization', auth).send(newJob);
    const second = await request(app).post(`${PREFIX}/orders`).set('Authorization', auth).send(newJob);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ACTIVE_ORDER_EXISTS');
  });

  it('refuses to let a pro post a job', async () => {
    const master = await makeMaster();
    const response = await request(app)
      .post(`${PREFIX}/orders`)
      .set('Authorization', bearer(master.id as string, UserRole.MASTER))
      .send(newJob);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ROLE_FORBIDDEN');
  });

  it('rejects a job with too short a description', async () => {
    const client = await makeClient();
    const response = await request(app)
      .post(`${PREFIX}/orders`)
      .set('Authorization', bearer(client.id as string, UserRole.CLIENT))
      .send({ ...newJob, description: 'broken' });

    expect(response.status).toBe(422);
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ field: 'description' }),
    );
  });

  describe('cancelling', () => {
    it('requires a reason and keeps it on the job', async () => {
      const client = await makeClient();
      const auth = bearer(client.id as string, UserRole.CLIENT);
      const posted = await request(app).post(`${PREFIX}/orders`).set('Authorization', auth).send(newJob);
      const orderId = posted.body.data.id as string;

      const withoutReason = await request(app)
        .post(`${PREFIX}/orders/${orderId}/cancel`)
        .set('Authorization', auth)
        .send({});
      expect(withoutReason.status).toBe(422);

      const cancelled = await request(app)
        .post(`${PREFIX}/orders/${orderId}/cancel`)
        .set('Authorization', auth)
        .send({ reason: 'The problem sorted itself out' });

      expect(cancelled.status).toBe(200);
      expect(cancelled.body.data.status).toBe(OrderStatus.CANCELLED);
      expect(cancelled.body.data.cancelReason).toBe('The problem sorted itself out');
      expect(cancelled.body.data.cancelledBy).toBe(UserRole.CLIENT);
    });

    it('will not cancel someone else’s job', async () => {
      const client = await makeClient();
      const stranger = await makeClient();
      const posted = await request(app)
        .post(`${PREFIX}/orders`)
        .set('Authorization', bearer(client.id as string, UserRole.CLIENT))
        .send(newJob);

      const response = await request(app)
        .post(`${PREFIX}/orders/${posted.body.data.id as string}/cancel`)
        .set('Authorization', bearer(stranger.id as string, UserRole.CLIENT))
        .send({ reason: 'Not mine but trying anyway' });

      expect(response.status).toBe(403);
    });

    it('will not cancel a completed job', async () => {
      const client = await makeClient();
      const master = await makeMaster({ crafts: ['computers'] as never });
      const clientAuth = bearer(client.id as string, UserRole.CLIENT);

      const posted = await request(app).post(`${PREFIX}/orders`).set('Authorization', clientAuth).send(newJob);
      const orderId = posted.body.data.id as string;
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });

      const masterAuth = bearer(master.id as string, UserRole.MASTER);
      await request(app).post(`${PREFIX}/orders/${orderId}/accept`).set('Authorization', masterAuth);
      await request(app).post(`${PREFIX}/orders/${orderId}/complete`).set('Authorization', masterAuth);

      const response = await request(app)
        .post(`${PREFIX}/orders/${orderId}/cancel`)
        .set('Authorization', clientAuth)
        .send({ reason: 'Changed my mind' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_COMPLETED');
    });
  });

  describe('rating', () => {
    it('will not rate a job that is not finished', async () => {
      const client = await makeClient();
      const auth = bearer(client.id as string, UserRole.CLIENT);
      const posted = await request(app).post(`${PREFIX}/orders`).set('Authorization', auth).send(newJob);

      const response = await request(app)
        .post(`${PREFIX}/reviews/master`)
        .set('Authorization', auth)
        .send({ orderId: posted.body.data.id, stars: 5 });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_NOT_COMPLETE');
    });

    it('rejects a star count outside 1–5', async () => {
      const client = await makeClient();
      const auth = bearer(client.id as string, UserRole.CLIENT);
      const posted = await request(app).post(`${PREFIX}/orders`).set('Authorization', auth).send(newJob);

      const response = await request(app)
        .post(`${PREFIX}/reviews/master`)
        .set('Authorization', auth)
        .send({ orderId: posted.body.data.id, stars: 6 });

      expect(response.status).toBe(422);
    });

    it('allows only one rating per job', async () => {
      const client = await makeClient();
      const master = await makeMaster({ crafts: ['computers'] as never });
      const clientAuth = bearer(client.id as string, UserRole.CLIENT);
      const masterAuth = bearer(master.id as string, UserRole.MASTER);

      const posted = await request(app).post(`${PREFIX}/orders`).set('Authorization', clientAuth).send(newJob);
      const orderId = posted.body.data.id as string;
      await new Promise((resolve) => {
        setTimeout(resolve, 200);
      });
      await request(app).post(`${PREFIX}/orders/${orderId}/accept`).set('Authorization', masterAuth);
      await request(app).post(`${PREFIX}/orders/${orderId}/complete`).set('Authorization', masterAuth);

      await request(app)
        .post(`${PREFIX}/reviews/master`)
        .set('Authorization', clientAuth)
        .send({ orderId, stars: 5 });

      const second = await request(app)
        .post(`${PREFIX}/reviews/master`)
        .set('Authorization', clientAuth)
        .send({ orderId, stars: 1 });

      expect(second.status).toBe(409);
      expect(await Review.countDocuments({ order: orderId })).toBe(1);
    });
  });

  describe('listing', () => {
    it('shows a client only their own jobs', async () => {
      const mine = await makeClient();
      const theirs = await makeClient();

      await request(app)
        .post(`${PREFIX}/orders`)
        .set('Authorization', bearer(mine.id as string, UserRole.CLIENT))
        .send(newJob);
      await request(app)
        .post(`${PREFIX}/orders`)
        .set('Authorization', bearer(theirs.id as string, UserRole.CLIENT))
        .send(newJob);

      const response = await request(app)
        .get(`${PREFIX}/orders`)
        .set('Authorization', bearer(mine.id as string, UserRole.CLIENT));

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.total).toBe(1);
    });

    it('returns the counts behind the filter pills', async () => {
      const client = await makeClient();
      const auth = bearer(client.id as string, UserRole.CLIENT);
      const posted = await request(app).post(`${PREFIX}/orders`).set('Authorization', auth).send(newJob);
      await request(app)
        .post(`${PREFIX}/orders/${posted.body.data.id as string}/cancel`)
        .set('Authorization', auth)
        .send({ reason: 'Found another pro' });

      const response = await request(app).get(`${PREFIX}/orders/counts`).set('Authorization', auth);

      expect(response.body.data.all).toBe(1);
      expect(response.body.data.cancelled).toBe(1);
    });

    it('keeps a stranger out of a job detail', async () => {
      const client = await makeClient();
      const stranger = await makeClient();
      const posted = await request(app)
        .post(`${PREFIX}/orders`)
        .set('Authorization', bearer(client.id as string, UserRole.CLIENT))
        .send(newJob);

      const response = await request(app)
        .get(`${PREFIX}/orders/${posted.body.data.id as string}`)
        .set('Authorization', bearer(stranger.id as string, UserRole.CLIENT));

      expect(response.status).toBe(403);
    });

    it('rejects a malformed id with a 422 rather than a cast error', async () => {
      const client = await makeClient();
      const response = await request(app)
        .get(`${PREFIX}/orders/not-an-id`)
        .set('Authorization', bearer(client.id as string, UserRole.CLIENT));

      expect(response.status).toBe(422);
    });
  });
});
