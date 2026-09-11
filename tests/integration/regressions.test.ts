import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { Order } from '../../src/modules/order/order.model';
import { User } from '../../src/modules/user/user.model';
import { AdminAction, AdminLog } from '../../src/modules/admin/adminLog.model';
import { Chat, Message } from '../../src/modules/chat/chat.model';
import { Product } from '../../src/modules/product/product.model';
import { Review, ReviewTarget } from '../../src/modules/review/review.model';
import { Transaction } from '../../src/modules/wallet/transaction.model';
import { Notification } from '../../src/modules/notification/notification.model';
import { rateProduct } from '../../src/modules/review/review.service';
import { resumableOfferFor, startMatching } from '../../src/modules/matching/matching.service';
import { keys, redis } from '../../src/config/redis';
import { NotFoundError } from '../../src/common/errors/ApiError';
import {
  NotificationType,
  OrderStatus,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { makeClient, makeMaster, makeOrder, makeSeller } from '../helpers/factories';

/**
 * One test per defect the role-by-role QA pass found, so none of them can come
 * back unnoticed.
 */

const PREFIX = '/api/v1';

const bearer = (id: string, role: UserRole): string =>
  `Bearer ${issueTokenPair(id, role).accessToken}`;

describe('regressions found in role QA', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  describe('ids on lean lists', () => {
    it('returns `id` on products, favourites, messages, reviews and transactions', async () => {
      const seller = await makeSeller();
      const client = await makeClient();
      const master = await makeMaster();
      const clientAuth = bearer(client.id as string, UserRole.CLIENT);
      const product = await Product.create({ seller: seller._id, title: 'Perforator', price: 850_000 });

      const favorite = await request(app)
        .post(`${PREFIX}/products/${product.id}/favorite`)
        .set('Authorization', clientAuth);
      expect(favorite.body.data).toEqual({ favorited: true });

      const list = await request(app).get(`${PREFIX}/products`).set('Authorization', clientAuth);
      expect(list.body.data.items[0].id).toBe(product.id);
      expect(list.body.data.favorites).toEqual([product.id]);

      const saved = await request(app).get(`${PREFIX}/products/favorites`).set('Authorization', clientAuth);
      expect(saved.body.data[0].id).toBe(product.id);

      await Review.create({
        author: client._id,
        targetType: ReviewTarget.PRODUCT,
        target: product._id,
        product: product._id,
        stars: 4,
      });
      const reviews = await request(app).get(`${PREFIX}/reviews/product/${product.id}`);
      expect(reviews.body.data.items[0].id).toEqual(expect.any(String));

      const order = await makeOrder(client._id, { status: OrderStatus.ACCEPTED });
      const chat = await Chat.create({ participants: [client._id, master._id], order: order._id });
      const message = await Message.create({ chat: chat._id, sender: client._id, text: 'Salom' });
      const messages = await request(app)
        .get(`${PREFIX}/chats/${chat.id}/messages`)
        .set('Authorization', clientAuth);
      expect(messages.body.data.items[0].id).toBe(message.id);

      await Transaction.create({
        user: master._id,
        type: TransactionType.TOP_UP,
        status: TransactionStatus.SUCCESS,
        provider: PaymentProvider.PAYME,
        amount: 10_000,
      });
      const transactions = await request(app)
        .get(`${PREFIX}/wallet/transactions`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER));
      expect(transactions.body.data.items[0].id).toEqual(expect.any(String));
    });
  });

  describe('favourites', () => {
    it('refuses to save a product that does not exist', async () => {
      const client = await makeClient();
      const response = await request(app)
        .post(`${PREFIX}/products/507f1f77bcf86cd799439011/favorite`)
        .set('Authorization', bearer(client.id as string, UserRole.CLIENT));
      expect(response.status).toBe(404);
    });

    it('stops counting a removed product, but still lets the shopper un-save it', async () => {
      const seller = await makeSeller();
      const client = await makeClient();
      const clientAuth = bearer(client.id as string, UserRole.CLIENT);
      const product = await Product.create({ seller: seller._id, title: 'Kafel', price: 5_000 });

      await request(app).post(`${PREFIX}/products/${product.id}/favorite`).set('Authorization', clientAuth);
      await Product.updateOne({ _id: product._id }, { isActive: false });

      const list = await request(app).get(`${PREFIX}/products`).set('Authorization', clientAuth);
      expect(list.body.data.favorites).toEqual([]);

      const unsave = await request(app)
        .post(`${PREFIX}/products/${product.id}/favorite`)
        .set('Authorization', clientAuth);
      expect(unsave.body.data).toEqual({ favorited: false });
    });
  });

  describe('removed products', () => {
    it('cannot be edited, removed again or reviewed', async () => {
      const seller = await makeSeller();
      const buyer = await makeClient();
      const sellerAuth = bearer(seller.id as string, UserRole.SELLER);
      const product = await Product.create({
        seller: seller._id,
        title: 'Drel',
        price: 100,
        isActive: false,
      });

      const edit = await request(app)
        .patch(`${PREFIX}/products/${product.id}`)
        .set('Authorization', sellerAuth)
        .send({ price: 200 });
      expect(edit.status).toBe(404);

      const remove = await request(app).delete(`${PREFIX}/products/${product.id}`).set('Authorization', sellerAuth);
      expect(remove.status).toBe(404);

      await expect(
        rateProduct(buyer.id as string, { productId: product.id as string, stars: 5 }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('product validation', () => {
    it.each([
      ['an empty price', { price: '' }],
      ['a null price', { price: null }],
      ['a boolean price', { price: true }],
      ['a price above a billion', { price: 2_000_000_000 }],
      // The attack string is the input under test, not code this file runs.
      // eslint-disable-next-line no-script-url
      ['a javascript: image', { price: 100, images: ['javascript:alert(1)'] }],
    ])('rejects %s', async (_label, fields) => {
      const seller = await makeSeller();
      const response = await request(app)
        .post(`${PREFIX}/products`)
        .set('Authorization', bearer(seller.id as string, UserRole.SELLER))
        .send({ title: 'Bolg‘a', ...fields });
      expect(response.status).toBe(422);
    });

    it('still accepts a price typed into a form as text', async () => {
      const seller = await makeSeller();
      const response = await request(app)
        .post(`${PREFIX}/products`)
        .set('Authorization', bearer(seller.id as string, UserRole.SELLER))
        .send({ title: 'Bolg‘a', price: '15000', stock: '3' });
      expect(response.status).toBe(201);
      expect(response.body.data.price).toBe(15_000);
      expect(response.body.data.stock).toBe(3);
    });
  });

  describe('product reviews', () => {
    it('keeps one review per author even when four arrive at once', async () => {
      await Review.init();
      const seller = await makeSeller();
      const buyer = await makeClient();
      const product = await Product.create({ seller: seller._id, title: 'Yelim', price: 30_000 });

      const results = await Promise.allSettled(
        [5, 4, 3, 2].map((stars) => rateProduct(buyer.id as string, { productId: product.id as string, stars })),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await Review.countDocuments({ target: product._id })).toBe(1);
    });
  });

  describe('private data', () => {
    it('shows no phone or balance on a pro’s public profile', async () => {
      const master = await makeMaster();
      const response = await request(app).get(`${PREFIX}/users/masters/${master.id}`);
      expect(response.status).toBe(200);
      expect(response.body.data.user.fullName).toBe('Bekzod Yuldashev');
      expect(response.body.data.user.phone).toBeUndefined();
      expect(response.body.data.user.balance).toBeUndefined();
    });

    it('hides the client’s phone in the feed until a pro has paid to accept', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      await makeOrder(client._id);

      const response = await request(app)
        .get(`${PREFIX}/orders/feed`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER));
      expect(response.status).toBe(200);
      expect(response.body.data.items[0].client.firstName).toBe('Dilnoza');
      expect(response.body.data.items[0].client.phone).toBeUndefined();
    });
  });

  describe('chats', () => {
    it('refuses messages to a closed chat', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const order = await makeOrder(client._id, { status: OrderStatus.ACCEPTED });
      const chat = await Chat.create({ participants: [client._id, master._id], order: order._id, isClosed: true });

      const response = await request(app)
        .post(`${PREFIX}/chats/${chat.id}/messages`)
        .set('Authorization', bearer(client.id as string, UserRole.CLIENT))
        .send({ text: 'Are you coming?' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('CHAT_CLOSED');
    });
  });

  describe('notifications', () => {
    const acceptedJob = async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const order = await makeOrder(client._id);
      await Order.updateOne({ _id: order._id }, { status: OrderStatus.ACCEPTED, master: master._id });
      return { client, master, order };
    };

    it('tells the client when the pro marks the job done', async () => {
      const { client, master, order } = await acceptedJob();
      const response = await request(app)
        .post(`${PREFIX}/orders/${order.id}/complete`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER));
      expect(response.status).toBe(200);
      expect(
        await Notification.countDocuments({ user: client._id, type: NotificationType.ORDER_COMPLETED }),
      ).toBe(1);
    });

    it('tells the pro when the client cancels an accepted job', async () => {
      const { client, master, order } = await acceptedJob();
      const response = await request(app)
        .post(`${PREFIX}/orders/${order.id}/cancel`)
        .set('Authorization', bearer(client.id as string, UserRole.CLIENT))
        .send({ reason: 'Plans changed' });
      expect(response.status).toBe(200);
      expect(
        await Notification.countDocuments({ user: master._id, type: NotificationType.ORDER_CANCELLED }),
      ).toBe(1);
    });
  });

  describe('sign-up', () => {
    const proPayload = {
      firstName: 'Sardor',
      lastName: 'Karimov',
      phone: '+998971112233',
      password: 'secret123',
      confirmPassword: 'secret123',
      role: UserRole.MASTER,
      acceptedRules: true,
      crafts: ['electrician'],
    };

    it('records the pro’s sign-up bonus in the ledger', async () => {
      const response = await request(app).post(`${PREFIX}/auth/register`).send(proPayload);
      expect(response.status).toBe(201);

      const entries = await Transaction.find({ user: response.body.data.user.id });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.type).toBe(TransactionType.ADJUSTMENT);
      expect(entries[0]!.amount).toBe(response.body.data.user.balance);
      expect(entries[0]!.balanceAfter).toBe(response.body.data.user.balance);
    });

    it('rejects the same trade picked twice', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...proPayload, crafts: ['plumber', 'plumber'] });
      expect(response.status).toBe(422);
    });
  });

  describe('wallet', () => {
    it('caps a single top-up', async () => {
      const master = await makeMaster();
      const response = await request(app)
        .post(`${PREFIX}/wallet/top-up`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER))
        .send({ amount: 50_000_000, provider: PaymentProvider.PAYME });
      expect(response.status).toBe(400);
    });
  });

  describe('matching', () => {
    it('does not ring a pro who is already holding another job’s offer', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const order = await makeOrder(client._id);
      await redis.set(keys.masterOffer(master.id as string), '507f1f77bcf86cd799439011', 'EX', 55);

      const state = await startMatching(order.id as string);

      expect(state.current).toBeNull();
      expect((await Order.findById(order._id))!.offers).toHaveLength(0);
    });

    it('hands a reconnecting pro the whole offer card, not just its id', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const order = await makeOrder(client._id);

      const state = await startMatching(order.id as string);
      expect(state.current).toBe(master.id);

      const offer = await resumableOfferFor(master.id as string);
      expect(offer).toEqual(
        expect.objectContaining({
          orderId: order.id,
          title: order.title,
          fee: 4999,
          resumed: true,
          client: expect.objectContaining({ name: 'Dilnoza R.' }),
        }),
      );
      expect(offer!.expiresInSeconds).toBeGreaterThan(0);
    });
  });

  describe('admin', () => {
    const makeAdmin = () =>
      User.create({
        phone: '+998935550001',
        passwordHash: 'admin-secret',
        firstName: 'Bosh',
        lastName: 'Admin',
        role: UserRole.ADMIN,
        acceptedRulesAt: new Date(),
      });

    it('refuses an access token issued before the account was blocked', async () => {
      const admin = await makeAdmin();
      const client = await makeClient();
      const oldToken = bearer(client.id as string, UserRole.CLIENT);

      expect((await request(app).get(`${PREFIX}/auth/me`).set('Authorization', oldToken)).status).toBe(200);

      await request(app)
        .patch(`${PREFIX}/admin/users/${client.id}/status`)
        .set('Authorization', bearer(admin.id as string, UserRole.ADMIN))
        .send({ isBlocked: true, blockReason: 'Soxta e’lonlar' });

      const after = await request(app).get(`${PREFIX}/auth/me`).set('Authorization', oldToken);
      expect(after.status).toBe(401);
      expect(after.body.error.code).toBe('TOKEN_REVOKED');
    });

    it('keeps the journal entry when a long reason would overflow its summary', async () => {
      const admin = await makeAdmin();
      const client = await makeClient();

      const response = await request(app)
        .patch(`${PREFIX}/admin/users/${client.id}/status`)
        .set('Authorization', bearer(admin.id as string, UserRole.ADMIN))
        .send({ isBlocked: true, blockReason: 'x'.repeat(300) });
      expect(response.status).toBe(200);

      const entry = await AdminLog.findOne({ action: AdminAction.USER_BLOCKED });
      expect(entry).not.toBeNull();
      expect(entry!.summary.length).toBeLessThanOrEqual(300);
    });

    it('will not restore a product its seller deleted', async () => {
      const admin = await makeAdmin();
      const seller = await makeSeller();
      const product = await Product.create({ seller: seller._id, title: 'Arra', price: 90_000 });

      await request(app)
        .delete(`${PREFIX}/products/${product.id}`)
        .set('Authorization', bearer(seller.id as string, UserRole.SELLER));

      const restore = await request(app)
        .patch(`${PREFIX}/admin/products/${product.id}`)
        .set('Authorization', bearer(admin.id as string, UserRole.ADMIN))
        .send({ isActive: true });
      expect(restore.status).toBe(409);
      expect(restore.body.error.code).toBe('PRODUCT_DELETED');
    });

    it('will not let an admin change their own balance', async () => {
      const admin = await makeAdmin();
      const response = await request(app)
        .post(`${PREFIX}/admin/users/${admin.id}/balance`)
        .set('Authorization', bearer(admin.id as string, UserRole.ADMIN))
        .send({ amount: 1000, note: 'Self top-up' });
      expect(response.status).toBe(403);
    });
  });
});
