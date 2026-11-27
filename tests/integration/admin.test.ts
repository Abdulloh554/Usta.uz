import { randomUUID } from 'node:crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { User } from '../../src/modules/user/user.model';
import { Order } from '../../src/modules/order/order.model';
import { Chat, Message } from '../../src/modules/chat/chat.model';
import { Product } from '../../src/modules/product/product.model';
import { Review, ReviewTarget } from '../../src/modules/review/review.model';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { Transaction } from '../../src/modules/wallet/transaction.model';
import { Notification } from '../../src/modules/notification/notification.model';
import { AdminLog, AdminAction } from '../../src/modules/admin/adminLog.model';
import { Visit } from '../../src/modules/traffic/traffic.model';
import { recomputeRating } from '../../src/modules/review/review.service';
import { purgeScrubbedAccounts } from '../../src/modules/user/user.service';
import {
  NotificationType,
  OrderStatus,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { makeClient, makeMaster, makeOrder, makeSeller, nextPhone } from '../helpers/factories';

const PREFIX = '/api/v1';

const bearer = (id: string, role: UserRole): string =>
  `Bearer ${issueTokenPair(id, role).accessToken}`;

const makeAdmin = () =>
  User.create({
    phone: nextPhone(),
    passwordHash: 'admin-secret',
    firstName: 'Bosh',
    lastName: 'Admin',
    role: UserRole.ADMIN,
    acceptedRulesAt: new Date(),
  });

describe('admin routes', () => {
  let app: Express;
  let auth: string;
  let adminId: string;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(async () => {
    const admin = await makeAdmin();
    adminId = admin.id as string;
    auth = bearer(adminId, UserRole.ADMIN);
  });

  describe('access', () => {
    it('rejects a request with no token', async () => {
      const response = await request(app).get(`${PREFIX}/admin/stats/overview`);
      expect(response.status).toBe(401);
    });

    it.each([UserRole.CLIENT, UserRole.MASTER, UserRole.SELLER])('rejects a %s', async (role) => {
      const user = await makeClient();
      const response = await request(app)
        .get(`${PREFIX}/admin/users`)
        .set('Authorization', bearer(user.id as string, role));
      expect(response.status).toBe(403);
    });
  });

  describe('stats', () => {
    it('counts users, jobs and the money the platform kept', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      await makeSeller();
      const done = await makeOrder(client._id, { status: OrderStatus.DONE });
      const cancelled = await makeOrder(client._id);
      await Order.updateOne(
        { _id: cancelled._id },
        { status: OrderStatus.CANCELLED, cancelReason: 'Changed my mind' },
      );

      await Transaction.create([
        {
          user: master._id,
          type: TransactionType.ORDER_FEE,
          status: TransactionStatus.SUCCESS,
          provider: PaymentProvider.BALANCE,
          amount: -4999,
          order: done._id,
        },
        {
          user: master._id,
          type: TransactionType.TOP_UP,
          status: TransactionStatus.SUCCESS,
          provider: PaymentProvider.PAYME,
          amount: 20_000,
        },
      ]);

      const response = await request(app)
        .get(`${PREFIX}/admin/stats/overview`)
        .set('Authorization', auth);

      expect(response.status).toBe(200);
      const { users, orders, finance } = response.body.data;
      expect(users.total).toBe(4);
      expect(users.byRole).toEqual({ client: 1, master: 1, seller: 1, admin: 1 });
      expect(users.newToday).toBe(4);
      expect(orders.byStatus.done).toBe(1);
      expect(orders.completionRate).toBe(50);
      expect(finance.feeRevenue).toBe(4999);
      expect(finance.netRevenue).toBe(4999);
      expect(finance.topUps).toBe(20_000);
      expect(finance.fee).toBe(4999);
      // Nothing visited yet: zeros, and no start date to show.
      expect(response.body.data.traffic).toEqual({ visits: 0, visitors: 0, today: 0, since: null });
    });

    it('counts website visits since the first one was recorded', async () => {
      const browser = randomUUID();
      const visit = (createdAt: Date, visitorId = browser, site = 'web') => ({
        visitorId,
        sessionId: randomUUID(),
        site,
        source: 'direct',
        path: '/uz',
        createdAt,
      });
      const first = new Date('2026-01-05T08:00:00Z');
      await Visit.insertMany([
        visit(new Date('2026-02-10T09:00:00Z')),
        visit(first),
        // Another browser, on the landing, today.
        visit(new Date(), randomUUID(), 'landing'),
      ]);

      const response = await request(app)
        .get(`${PREFIX}/admin/stats/overview`)
        .set('Authorization', auth);

      expect(response.status).toBe(200);
      expect(response.body.data.traffic).toEqual({
        visits: 3,
        visitors: 2,
        today: 1,
        since: first.toISOString(),
      });
    });

    it('returns one zero-filled point per day', async () => {
      await makeClient();
      const response = await request(app)
        .get(`${PREFIX}/admin/stats/timeseries?days=14`)
        .set('Authorization', auth);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(14);
      const today = response.body.data[13];
      // The admin and the client were both created today.
      expect(today.users).toBe(2);
      expect(response.body.data[0].users).toBe(0);
    });

    it('lists the busiest pros', async () => {
      await makeMaster({ firstName: 'Bekzod' });
      const response = await request(app)
        .get(`${PREFIX}/admin/stats/top-masters`)
        .set('Authorization', auth);
      expect(response.status).toBe(200);
      expect(response.body.data[0].name).toBe('Bekzod Yuldashev');
    });

    it('reports the system configuration without secrets', async () => {
      const response = await request(app).get(`${PREFIX}/admin/system`).set('Authorization', auth);
      expect(response.status).toBe(200);
      expect(response.body.data.fee).toBe(4999);
      expect(JSON.stringify(response.body)).not.toContain('secret');
    });
  });

  describe('users', () => {
    it('searches by name and by phone digits', async () => {
      const client = await makeClient({ firstName: 'Shahnoza' });
      await makeMaster();

      const byName = await request(app)
        .get(`${PREFIX}/admin/users?search=shahn`)
        .set('Authorization', auth);
      expect(byName.body.data.items).toHaveLength(1);
      expect(byName.body.data.items[0].id).toBe(client.id);
      expect(JSON.stringify(byName.body)).not.toContain('passwordHash');

      const byPhone = await request(app)
        .get(`${PREFIX}/admin/users?search=${client.phone.slice(-7)}`)
        .set('Authorization', auth);
      expect(byPhone.body.data.items[0].id).toBe(client.id);
    });

    it('filters by role and status', async () => {
      await makeClient();
      const master = await makeMaster();
      await User.updateOne({ _id: master._id }, { isBlocked: true });

      const masters = await request(app)
        .get(`${PREFIX}/admin/users?role=master`)
        .set('Authorization', auth);
      expect(masters.body.data.total).toBe(1);

      const blocked = await request(app)
        .get(`${PREFIX}/admin/users?status=blocked`)
        .set('Authorization', auth);
      expect(blocked.body.data.items[0].id).toBe(master.id);
    });

    it('returns a profile with its counts and history', async () => {
      const master = await makeMaster();
      const client = await makeClient();
      await Order.create({
        code: 'ABC234',
        client: client._id,
        master: master._id,
        title: 'Socket sparks',
        description: 'The kitchen socket sparks when plugged in.',
        category: 'electrical',
        status: OrderStatus.ACCEPTED,
      });

      const response = await request(app)
        .get(`${PREFIX}/admin/users/${master.id}`)
        .set('Authorization', auth);

      expect(response.status).toBe(200);
      expect(response.body.data.masterProfile.crafts).toEqual(['electrician']);
      expect(response.body.data.counts.ordersAsMaster).toBe(1);
      expect(response.body.data.recentOrders).toHaveLength(1);
    });

    it('blocks an account, which then cannot sign in', async () => {
      const client = await makeClient();

      const blocked = await request(app)
        .patch(`${PREFIX}/admin/users/${client.id}/status`)
        .set('Authorization', auth)
        .send({ isBlocked: true, blockReason: 'Fake job posts' });

      expect(blocked.status).toBe(200);
      expect(blocked.body.data.isBlocked).toBe(true);

      const login = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ phone: client.phone, password: 'secret123' });
      expect(login.status).toBe(403);
      expect(login.body.error.code).toBe('ACCOUNT_BLOCKED');

      const log = await AdminLog.findOne({ action: AdminAction.USER_BLOCKED });
      expect(log!.targetId!.toString()).toBe(client.id);
    });

    it('takes a blocked pro offline', async () => {
      const master = await makeMaster({ isOnline: true });
      await request(app)
        .patch(`${PREFIX}/admin/users/${master.id}/status`)
        .set('Authorization', auth)
        .send({ isBlocked: true, blockReason: 'No-shows' });

      const profile = await MasterProfile.findOne({ user: master._id });
      expect(profile!.isOnline).toBe(false);
    });

    it('demands a reason to block', async () => {
      const client = await makeClient();
      const response = await request(app)
        .patch(`${PREFIX}/admin/users/${client.id}/status`)
        .set('Authorization', auth)
        .send({ isBlocked: true });
      expect(response.status).toBe(400);
    });

    it('refuses to block the admin themself or another admin', async () => {
      const self = await request(app)
        .patch(`${PREFIX}/admin/users/${adminId}/status`)
        .set('Authorization', auth)
        .send({ isActive: false });
      expect(self.status).toBe(403);

      const other = await makeAdmin();
      const response = await request(app)
        .patch(`${PREFIX}/admin/users/${other.id}/status`)
        .set('Authorization', auth)
        .send({ isBlocked: true, blockReason: 'x-x-x' });
      expect(response.status).toBe(403);
    });

    it('credits and debits a wallet with a recorded transaction', async () => {
      const master = await makeMaster({ balance: 10_000 });

      const credit = await request(app)
        .post(`${PREFIX}/admin/users/${master.id}/balance`)
        .set('Authorization', auth)
        .send({ amount: 5000, note: 'Compensation for a fake job' });

      expect(credit.status).toBe(200);
      expect(credit.body.data.user.balance).toBe(15_000);
      expect(credit.body.data.transaction.type).toBe(TransactionType.ADJUSTMENT);
      expect(credit.body.data.transaction.balanceAfter).toBe(15_000);

      const debit = await request(app)
        .post(`${PREFIX}/admin/users/${master.id}/balance`)
        .set('Authorization', auth)
        .send({ amount: -15_000, note: 'Reversal' });
      expect(debit.body.data.user.balance).toBe(0);
    });

    it('never debits a wallet below zero', async () => {
      const master = await makeMaster({ balance: 1000 });
      const response = await request(app)
        .post(`${PREFIX}/admin/users/${master.id}/balance`)
        .set('Authorization', auth)
        .send({ amount: -5000, note: 'Too much' });

      expect(response.status).toBe(402);
      expect((await User.findById(master._id))!.balance).toBe(1000);
      expect(await Transaction.countDocuments({ type: TransactionType.ADJUSTMENT })).toBe(0);
    });

    it('signs a user out everywhere', async () => {
      const client = await makeClient();
      const response = await request(app)
        .post(`${PREFIX}/admin/users/${client.id}/revoke-sessions`)
        .set('Authorization', auth);
      expect(response.status).toBe(200);
      expect(await AdminLog.countDocuments({ action: AdminAction.USER_SESSIONS_REVOKED })).toBe(1);
    });
  });

  describe('deleting a user', () => {
    const remove = (id: string, body: Record<string, unknown> = { reason: 'Soxta hisob' }) =>
      request(app).post(`${PREFIX}/admin/users/${id}/delete`).set('Authorization', auth).send(body);
    const overview = () =>
      request(app).get(`${PREFIX}/admin/stats/overview`).set('Authorization', auth);

    it('removes a pro and everything about them, keeping the jobs they did for others', async () => {
      const master = await makeMaster({ firstName: 'Jasur' });
      const client = await makeClient();
      const job = await makeOrder(client._id, { status: OrderStatus.DONE });
      await Order.updateOne(
        { _id: job._id },
        { master: master._id, offers: [{ master: master._id, outcome: 'accepted' }] },
      );
      const chat = await Chat.create({ participants: [client._id, master._id], order: job._id });
      await Message.create({ chat: chat._id, sender: master._id, text: 'Ertaga kelaman' });
      await Review.create({
        author: client._id,
        targetType: ReviewTarget.MASTER,
        target: master._id,
        order: job._id,
        stars: 5,
      });
      await Notification.create({
        user: master._id,
        type: NotificationType.ANNOUNCEMENT,
        title: 'Salom',
      });
      await Transaction.create([
        {
          user: master._id,
          type: TransactionType.ORDER_FEE,
          status: TransactionStatus.SUCCESS,
          provider: PaymentProvider.BALANCE,
          amount: -4999,
          order: job._id,
        },
        {
          user: master._id,
          type: TransactionType.TOP_UP,
          status: TransactionStatus.PENDING,
          provider: PaymentProvider.MANUAL,
          amount: 20_000,
        },
      ]);
      // An earlier journal entry about them, with their name in it.
      await request(app)
        .post(`${PREFIX}/admin/users/${master.id as string}/revoke-sessions`)
        .set('Authorization', auth)
        .expect(200);

      const response = await remove(master.id as string);

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ deleted: true });
      expect(await User.exists({ _id: master._id })).toBeNull();
      expect(await MasterProfile.countDocuments({ user: master._id })).toBe(0);
      expect(await Chat.countDocuments({ _id: chat._id })).toBe(0);
      expect(await Message.countDocuments({ chat: chat._id })).toBe(0);
      expect(await Review.countDocuments({ target: master._id })).toBe(0);
      expect(await Notification.countDocuments({ user: master._id })).toBe(0);

      // The client's job stays, with no pro on it and nothing left to rate.
      const kept = await Order.findById(job._id).lean();
      expect(kept!.master).toBeUndefined();
      expect(kept!.offers).toHaveLength(0);
      expect(kept!.isRated).toBe(true);

      // Settled money stays in the ledger without a name; the pending request goes.
      const ledger = await Transaction.find({ order: job._id }).lean();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.user).toBeUndefined();
      expect(await Transaction.countDocuments({ status: TransactionStatus.PENDING })).toBe(0);

      // The journal keeps only the deletion itself, without their name.
      const entries = await AdminLog.find({ targetId: master._id }).lean();
      expect(entries.map((entry) => entry.action)).toEqual([AdminAction.USER_DELETED]);
      expect(entries[0]!.summary).toContain('Soxta hisob');
      expect(entries[0]!.summary).not.toContain('Jasur');
    });

    it("removes a client's own jobs and the reviews they wrote, and recounts the pro", async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const job = await makeOrder(client._id, { status: OrderStatus.DONE });
      await Order.updateOne({ _id: job._id }, { master: master._id, isRated: true });
      await Review.create({
        author: client._id,
        targetType: ReviewTarget.MASTER,
        target: master._id,
        order: job._id,
        stars: 2,
      });
      await recomputeRating(ReviewTarget.MASTER, master._id);
      expect((await MasterProfile.findOne({ user: master._id }))!.ratingCount).toBe(1);

      await remove(client.id as string).expect(200);

      expect(await Order.countDocuments({ _id: job._id })).toBe(0);
      expect(await Review.countDocuments({ author: client._id })).toBe(0);
      expect((await MasterProfile.findOne({ user: master._id }))!.ratingCount).toBe(0);
      // The pro themself is untouched.
      expect(await User.exists({ _id: master._id })).not.toBeNull();
    });

    it('takes their wallet out of the totals, and their number is free again', async () => {
      const master = await makeMaster({ balance: 70_000 });
      expect((await overview()).body.data.finance.walletBalances).toBe(70_000);

      await remove(master.id as string).expect(200);

      const after = (await overview()).body.data;
      expect(after.finance.walletBalances).toBe(0);
      expect(after.users.byRole.master).toBe(0);
      const profile = await request(app)
        .get(`${PREFIX}/admin/users/${master.id as string}`)
        .set('Authorization', auth);
      expect(profile.status).toBe(404);

      // Not banned: the same number signs up as a new, empty account.
      const again = await request(app).post(`${PREFIX}/auth/register`).send({
        firstName: 'Yangi',
        lastName: 'Hisob',
        phone: master.phone,
        password: 'secret123',
        role: UserRole.CLIENT,
        acceptedRules: true,
      });
      expect(again.status).toBe(201);
      expect(again.body.data.user.balance).toBe(0);
    });

    it('refuses while the user still has a live job', async () => {
      const client = await makeClient();
      await makeOrder(client._id, { status: OrderStatus.PENDING });

      const response = await remove(client.id as string);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ACTIVE_ORDER_EXISTS');
      expect(await User.exists({ _id: client._id })).not.toBeNull();
    });

    it('asks for a reason, and spares the admin themself and other admins', async () => {
      const client = await makeClient();
      expect((await remove(client.id as string, {})).status).toBe(422);
      expect((await remove(client.id as string, { reason: 'x' })).status).toBe(422);

      expect((await remove(adminId)).body.error.code).toBe('ADMIN_SELF');
      const other = await makeAdmin();
      expect((await remove(other.id as string)).body.error.code).toBe('ADMIN_PROTECTED');
    });

    it('finishes accounts the old deletion only scrubbed, wallet included', async () => {
      const leftover = await makeMaster({ balance: 12_000 });
      const job = await makeOrder(leftover._id, { status: OrderStatus.DONE });
      await User.updateOne(
        { _id: leftover._id },
        {
          $set: {
            phone: `deleted:${leftover.id as string}`,
            firstName: 'Oʻchirilgan',
            lastName: 'foydalanuvchi',
            isActive: false,
            deletedAt: new Date(),
          },
        },
      );
      const alive = await makeClient();

      expect(await purgeScrubbedAccounts()).toBe(1);

      expect(await User.exists({ _id: leftover._id })).toBeNull();
      expect(await Order.countDocuments({ _id: job._id })).toBe(0);
      expect(await User.exists({ _id: alive._id })).not.toBeNull();
      expect((await overview()).body.data.finance.walletBalances).toBe(0);
      // Once done, there is nothing left to find.
      expect(await purgeScrubbedAccounts()).toBe(0);
    });
  });

  describe('jobs', () => {
    it('lists and finds jobs by code', async () => {
      const client = await makeClient();
      const order = await makeOrder(client._id);
      await makeOrder(client._id, { status: OrderStatus.DONE });

      const all = await request(app).get(`${PREFIX}/admin/orders`).set('Authorization', auth);
      expect(all.body.data.total).toBe(2);
      expect(all.body.data.items[0].client.firstName).toBe('Dilnoza');

      const found = await request(app)
        .get(`${PREFIX}/admin/orders?search=%23${order.code}`)
        .set('Authorization', auth);
      expect(found.body.data.items).toHaveLength(1);

      const detail = await request(app)
        .get(`${PREFIX}/admin/orders/${order.id}`)
        .set('Authorization', auth);
      expect(detail.status).toBe(200);
      expect(detail.body.data.order.code).toBe(order.code);
    });

    it('cancels an accepted job, notifies both sides and refunds the fee', async () => {
      const client = await makeClient();
      const master = await makeMaster({ balance: 0 });
      const order = await makeOrder(client._id, { status: OrderStatus.ACCEPTED });
      order.master = master._id;
      await order.save();
      await Transaction.create({
        user: master._id,
        type: TransactionType.ORDER_FEE,
        status: TransactionStatus.SUCCESS,
        provider: PaymentProvider.BALANCE,
        amount: -4999,
        order: order._id,
      });

      const response = await request(app)
        .post(`${PREFIX}/admin/orders/${order.id}/cancel`)
        .set('Authorization', auth)
        .send({ reason: 'The pro never arrived', refundFee: true });

      expect(response.status).toBe(200);
      expect(response.body.data.refunded).toBe(4999);

      const saved = await Order.findById(order._id);
      expect(saved!.status).toBe(OrderStatus.CANCELLED);
      expect(saved!.cancelledBy).toBe(UserRole.ADMIN);
      expect((await User.findById(master._id))!.balance).toBe(4999);
      expect(await Notification.countDocuments({ type: NotificationType.ORDER_CANCELLED })).toBe(2);
    });

    it('will not cancel a job twice', async () => {
      const client = await makeClient();
      const order = await makeOrder(client._id);
      await Order.updateOne(
        { _id: order._id },
        { status: OrderStatus.CANCELLED, cancelReason: 'Spam' },
      );

      const response = await request(app)
        .post(`${PREFIX}/admin/orders/${order.id}/cancel`)
        .set('Authorization', auth)
        .send({ reason: 'Duplicate' });
      expect(response.status).toBe(409);
    });

    it('refunds the fee on a job the pro already cancelled, but only once', async () => {
      const client = await makeClient();
      const master = await makeMaster({ balance: 0 });
      const order = await makeOrder(client._id);
      await Order.updateOne(
        { _id: order._id },
        { status: OrderStatus.CANCELLED, cancelReason: 'Pro cancelled', master: master._id },
      );
      await Transaction.create({
        user: master._id,
        type: TransactionType.ORDER_FEE,
        status: TransactionStatus.SUCCESS,
        provider: PaymentProvider.BALANCE,
        amount: -4999,
        order: order._id,
      });

      const send = () =>
        request(app)
          .post(`${PREFIX}/admin/orders/${order.id}/cancel`)
          .set('Authorization', auth)
          .send({ reason: 'Support ruled for the pro', refundFee: true });

      const first = await send();
      expect(first.status).toBe(200);
      expect(first.body.data.refunded).toBe(4999);
      expect(await AdminLog.countDocuments({ action: AdminAction.ORDER_FEE_REFUNDED })).toBe(1);

      const second = await send();
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('NOTHING_TO_REFUND');
    });
  });

  describe('chats', () => {
    const setUpChat = async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const order = await makeOrder(client._id, { status: OrderStatus.ACCEPTED });
      const chat = await Chat.create({ participants: [client._id, master._id], order: order._id });
      const first = await Message.create({ chat: chat._id, sender: client._id, text: 'Hello' });
      const second = await Message.create({
        chat: chat._id,
        sender: master._id,
        text: 'Call me at +998...',
      });
      chat.lastMessage = second._id;
      chat.lastMessageAt = second.createdAt;
      await chat.save();
      return { chat, order, first, second };
    };

    it('lists chats with message counts and reads a thread oldest-first', async () => {
      const { chat, order } = await setUpChat();

      const list = await request(app)
        .get(`${PREFIX}/admin/chats?search=${order.code}`)
        .set('Authorization', auth);
      expect(list.body.data.items).toHaveLength(1);
      expect(list.body.data.items[0].messageCount).toBe(2);

      const thread = await request(app)
        .get(`${PREFIX}/admin/chats/${chat.id}/messages`)
        .set('Authorization', auth);
      const texts = (thread.body.data.items as Array<{ text: string }>).map((m) => m.text);
      expect(texts).toEqual(['Hello', 'Call me at +998...']);
    });

    it('deletes a message and rewinds the chat preview', async () => {
      const { chat, first, second } = await setUpChat();

      const response = await request(app)
        .delete(`${PREFIX}/admin/messages/${second.id}`)
        .set('Authorization', auth);
      expect(response.status).toBe(204);

      const saved = await Chat.findById(chat._id);
      expect(saved!.lastMessage!.toString()).toBe(first.id);
    });

    it('closes a chat', async () => {
      const { chat } = await setUpChat();
      const response = await request(app)
        .patch(`${PREFIX}/admin/chats/${chat.id}`)
        .set('Authorization', auth)
        .send({ isClosed: true });
      expect(response.body.data.isClosed).toBe(true);
    });
  });

  describe('moderation', () => {
    it('hides and restores a product, including ones sellers hid', async () => {
      const seller = await makeSeller();
      const product = await Product.create({
        seller: seller._id,
        title: 'Perforator',
        price: 850_000,
      });

      const hidden = await request(app)
        .patch(`${PREFIX}/admin/products/${product.id}`)
        .set('Authorization', auth)
        .send({ isActive: false });
      expect(hidden.body.data.isActive).toBe(false);

      const list = await request(app)
        .get(`${PREFIX}/admin/products?status=hidden`)
        .set('Authorization', auth);
      expect(list.body.data.items).toHaveLength(1);
    });

    it('hides a review and corrects the pro rating', async () => {
      const master = await makeMaster();
      const client = await makeClient();
      await Review.create({
        author: client._id,
        targetType: ReviewTarget.MASTER,
        target: master._id,
        stars: 5,
      });
      const bad = await Review.create({
        author: (await makeClient())._id,
        targetType: ReviewTarget.MASTER,
        target: master._id,
        stars: 1,
      });

      const response = await request(app)
        .patch(`${PREFIX}/admin/reviews/${bad.id}`)
        .set('Authorization', auth)
        .send({ isVisible: false });
      expect(response.status).toBe(200);

      const profile = await MasterProfile.findOne({ user: master._id });
      expect(profile!.rating).toBe(5);
      expect(profile!.ratingCount).toBe(1);

      const list = await request(app)
        .get(`${PREFIX}/admin/reviews?visible=false`)
        .set('Authorization', auth);
      expect(list.body.data.items[0].targetName).toBe('Bekzod Yuldashev');
    });
  });

  describe('transactions', () => {
    it('lists with per-type totals', async () => {
      const master = await makeMaster();
      await Transaction.create([
        {
          user: master._id,
          type: TransactionType.TOP_UP,
          status: TransactionStatus.SUCCESS,
          provider: PaymentProvider.CLICK,
          amount: 10_000,
        },
        {
          user: master._id,
          type: TransactionType.TOP_UP,
          status: TransactionStatus.SUCCESS,
          provider: PaymentProvider.PAYME,
          amount: 5_000,
        },
      ]);

      const response = await request(app)
        .get(`${PREFIX}/admin/transactions?type=top_up`)
        .set('Authorization', auth);
      expect(response.body.data.total).toBe(2);
      expect(response.body.data.totals).toEqual([{ type: 'top_up', total: 15_000, count: 2 }]);
    });
  });

  describe('filters and edge cases', () => {
    it('accepts every list filter', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const seller = await makeSeller();
      const order = await makeOrder(client._id);
      await Product.create({ seller: seller._id, title: 'Drel', price: 100, category: 'tools' });
      await Review.create({
        author: client._id,
        targetType: ReviewTarget.MASTER,
        target: master._id,
        stars: 4,
      });
      await Transaction.create({
        user: master._id,
        type: TransactionType.TOP_UP,
        status: TransactionStatus.PENDING,
        provider: PaymentProvider.CLICK,
        amount: 1000,
      });
      const chat = await Chat.create({ participants: [client._id, master._id], order: order._id });

      const expectations: Array<[string, number]> = [
        ['/admin/users?status=active&sort=old', 4],
        ['/admin/users?status=inactive&sort=balance', 0],
        [`/admin/users?sort=seen&search=${client.id}`, 1],
        ['/admin/users?search=Dilnoza%20Rahimova', 1],
        [`/admin/orders?status=pending&category=electrical&user=${client.id}&search=laptop`, 1],
        [`/admin/orders?search=${order.id}`, 1],
        [`/admin/chats?status=open&user=${master.id}`, 1],
        ['/admin/chats?status=closed', 0],
        [`/admin/products?status=active&search=drel&seller=${seller.id}`, 1],
        [`/admin/reviews?targetType=master&visible=true&stars=4&author=${client.id}`, 1],
        [`/admin/transactions?status=pending&provider=click&user=${master.id}`, 1],
        [`/admin/logs?action=user.blocked&admin=${adminId}`, 0],
      ];

      for (const [url, count] of expectations) {
        const response = await request(app).get(`${PREFIX}${url}`).set('Authorization', auth);
        expect(response.status).toBe(200);
        expect({ url, total: response.body.data.total }).toEqual({ url, total: count });
      }

      const detail = await request(app)
        .get(`${PREFIX}/admin/chats/${chat.id}`)
        .set('Authorization', auth);
      expect(detail.body.data.order.code).toBe(order.code);

      const sellerDetail = await request(app)
        .get(`${PREFIX}/admin/users/${seller.id}`)
        .set('Authorization', auth);
      expect(sellerDetail.body.data.masterProfile).toBeNull();
      expect(sellerDetail.body.data.counts.products).toBe(1);
    });

    it('deactivates, reactivates and unblocks, journaling only real changes', async () => {
      const client = await makeClient();
      const patch = (body: object) =>
        request(app)
          .patch(`${PREFIX}/admin/users/${client.id}/status`)
          .set('Authorization', auth)
          .send(body);

      expect((await patch({ isActive: false })).body.data.isActive).toBe(false);
      expect((await patch({ isActive: true })).body.data.isActive).toBe(true);
      await patch({ isBlocked: true, blockReason: 'Spam' });
      const unblocked = await patch({ isBlocked: false });
      expect(unblocked.body.data.isBlocked).toBe(false);
      expect(unblocked.body.data.blockReason).toBeUndefined();

      // Nothing changes, so nothing is written.
      await patch({ isBlocked: false, isActive: true });
      expect(await AdminLog.countDocuments({ targetId: client._id })).toBe(4);
    });

    it('returns 404 for records that do not exist', async () => {
      const missing = new mongoose.Types.ObjectId().toString();
      const calls = [
        request(app).get(`${PREFIX}/admin/users/${missing}`),
        request(app)
          .post(`${PREFIX}/admin/users/${missing}/balance`)
          .send({ amount: 10, note: 'Test' }),
        request(app).patch(`${PREFIX}/admin/users/${missing}/status`).send({ isActive: false }),
        request(app).get(`${PREFIX}/admin/orders/${missing}`),
        request(app).post(`${PREFIX}/admin/orders/${missing}/cancel`).send({ reason: 'Missing' }),
        request(app).get(`${PREFIX}/admin/chats/${missing}`),
        request(app).get(`${PREFIX}/admin/chats/${missing}/messages`),
        request(app).patch(`${PREFIX}/admin/chats/${missing}`).send({ isClosed: true }),
        request(app).delete(`${PREFIX}/admin/messages/${missing}`),
        request(app).patch(`${PREFIX}/admin/products/${missing}`).send({ isActive: true }),
        request(app).patch(`${PREFIX}/admin/reviews/${missing}`).send({ isVisible: true }),
      ];

      for (const call of calls) {
        const response = await call.set('Authorization', auth);
        expect(response.status).toBe(404);
      }
    });

    it('rejects malformed bodies', async () => {
      const client = await makeClient();
      const empty = await request(app)
        .patch(`${PREFIX}/admin/users/${client.id}/status`)
        .set('Authorization', auth)
        .send({});
      expect(empty.status).toBe(422);

      const zero = await request(app)
        .post(`${PREFIX}/admin/users/${client.id}/balance`)
        .set('Authorization', auth)
        .send({ amount: 0, note: 'Nothing' });
      expect(zero.status).toBe(422);
    });

    it('cancels a job that is still looking for a pro', async () => {
      const client = await makeClient();
      const order = await makeOrder(client._id);

      const response = await request(app)
        .post(`${PREFIX}/admin/orders/${order.id}/cancel`)
        .set('Authorization', auth)
        .send({ reason: 'Fake job' });

      expect(response.status).toBe(200);
      expect(response.body.data.refunded).toBe(0);
      expect(response.body.data.order.status).toBe(OrderStatus.CANCELLED);
      // No pro yet, so only the client hears about it.
      expect(await Notification.countDocuments({ type: NotificationType.ORDER_CANCELLED })).toBe(1);
    });

    it('will not cancel a completed job without a refund', async () => {
      const client = await makeClient();
      const order = await makeOrder(client._id, { status: OrderStatus.DONE });
      const response = await request(app)
        .post(`${PREFIX}/admin/orders/${order.id}/cancel`)
        .set('Authorization', auth)
        .send({ reason: 'Too late' });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('ORDER_COMPLETED');
    });

    it('reopens a chat and deletes an older message without touching the preview', async () => {
      const client = await makeClient();
      const master = await makeMaster();
      const order = await makeOrder(client._id);
      const chat = await Chat.create({
        participants: [client._id, master._id],
        order: order._id,
        isClosed: true,
      });
      const older = await Message.create({ chat: chat._id, sender: client._id, text: 'First' });
      const latest = await Message.create({ chat: chat._id, sender: master._id, text: 'Second' });
      chat.lastMessage = latest._id;
      await chat.save();

      const reopened = await request(app)
        .patch(`${PREFIX}/admin/chats/${chat.id}`)
        .set('Authorization', auth)
        .send({ isClosed: false });
      expect(reopened.body.data.isClosed).toBe(false);

      await request(app).delete(`${PREFIX}/admin/messages/${older.id}`).set('Authorization', auth);
      const saved = await Chat.findById(chat._id);
      expect(saved!.lastMessage!.toString()).toBe(latest.id);
    });

    it('restores a hidden product and a hidden review', async () => {
      const seller = await makeSeller();
      const client = await makeClient();
      const product = await Product.create({
        seller: seller._id,
        title: 'Kafel',
        price: 5000,
        isActive: false,
      });
      const review = await Review.create({
        author: client._id,
        targetType: ReviewTarget.PRODUCT,
        target: product._id,
        product: product._id,
        stars: 3,
        isVisible: false,
      });

      const restored = await request(app)
        .patch(`${PREFIX}/admin/products/${product.id}`)
        .set('Authorization', auth)
        .send({ isActive: true });
      expect(restored.body.data.isActive).toBe(true);

      await request(app)
        .patch(`${PREFIX}/admin/reviews/${review.id}`)
        .set('Authorization', auth)
        .send({ isVisible: true });
      expect((await Product.findById(product._id))!.rating).toBe(3);

      const list = await request(app)
        .get(`${PREFIX}/admin/reviews?targetType=product`)
        .set('Authorization', auth);
      expect(list.body.data.items[0].targetName).toBe('Kafel');
    });
  });

  describe('broadcasts', () => {
    it('reaches every role but never another admin', async () => {
      await makeClient();
      await makeMaster();
      await makeSeller();
      await makeAdmin();

      const response = await request(app)
        .post(`${PREFIX}/admin/broadcasts`)
        .set('Authorization', auth)
        .send({ audience: 'all', title: 'Bayram', body: 'Bayramingiz muborak!' });

      expect(response.body.data).toMatchObject({ recipients: 3, delivered: 0, status: 'queued' });
      const { processBroadcastBatch } = await import('../../src/modules/admin/broadcast.service');
      await processBroadcastBatch();
      expect(await Notification.countDocuments({ type: NotificationType.ANNOUNCEMENT })).toBe(3);
    });

    it('notifies every active user in the audience and journals it', async () => {
      await makeMaster();
      await makeMaster();
      await makeClient();
      const blocked = await makeMaster();
      await User.updateOne({ _id: blocked._id }, { isBlocked: true });

      const response = await request(app)
        .post(`${PREFIX}/admin/broadcasts`)
        .set('Authorization', auth)
        .send({ audience: 'master', title: 'Yangi tarif', body: 'Ertadan xizmat haqi o‘zgaradi.' });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ recipients: 2, delivered: 0, status: 'queued' });
      const { processBroadcastBatch } = await import('../../src/modules/admin/broadcast.service');
      await processBroadcastBatch();
      expect(await Notification.countDocuments({ type: NotificationType.ANNOUNCEMENT })).toBe(2);

      const logs = await request(app).get(`${PREFIX}/admin/logs`).set('Authorization', auth);
      expect(logs.body.data.items[0].action).toBe(AdminAction.BROADCAST_SENT);
      expect(logs.body.data.items[0].admin.firstName).toBe('Bosh');
    });
  });
});
