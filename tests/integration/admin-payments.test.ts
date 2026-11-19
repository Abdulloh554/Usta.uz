import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { User } from '../../src/modules/user/user.model';
import { Transaction } from '../../src/modules/wallet/transaction.model';
import { Notification } from '../../src/modules/notification/notification.model';
import { AdminLog, AdminAction } from '../../src/modules/admin/adminLog.model';
import {
  NotificationType,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { makeClient, makeMaster, nextPhone } from '../helpers/factories';

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

describe('admin payments', () => {
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

  /** Files a request the way the app does, so the tests cover the real path. */
  const fileRequest = async (masterId: string, amount = 50_000): Promise<string> => {
    const response = await request(app)
      .post(`${PREFIX}/wallet/top-up-requests`)
      .set('Authorization', bearer(masterId, UserRole.MASTER))
      .send({ amount, payerNote: 'Karta oxiri 1234, Ali Valiyev' });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  };

  describe('GET /admin/payments', () => {
    it('lists manual top-ups with the populated user, pending by default', async () => {
      const master = await makeMaster({ balance: 3_000, firstName: 'Sardor' });
      const id = await fileRequest(master.id as string);
      // Noise that must not show up: a Payme checkout and a fee.
      await Transaction.create({
        user: master._id,
        type: TransactionType.TOP_UP,
        status: TransactionStatus.PENDING,
        provider: PaymentProvider.PAYME,
        amount: 10_000,
      });
      await Transaction.create({
        user: master._id,
        type: TransactionType.ORDER_FEE,
        status: TransactionStatus.SUCCESS,
        provider: PaymentProvider.BALANCE,
        amount: -4999,
      });

      const response = await request(app).get(`${PREFIX}/admin/payments`).set('Authorization', auth);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ total: 1, page: 1, pages: 1 });
      const [item] = response.body.data.items;
      expect(item).toMatchObject({
        id,
        amount: 50_000,
        status: 'pending',
        provider: 'manual',
        meta: { payerNote: 'Karta oxiri 1234, Ali Valiyev' },
        user: {
          id: master.id,
          firstName: 'Sardor',
          lastName: 'Yuldashev',
          phone: master.phone,
          balance: 3_000,
        },
      });
    });

    it('filters by status and searches by name or phone', async () => {
      const a = await makeMaster({ firstName: 'Sardor' });
      const b = await makeMaster({ firstName: 'Jamshid' });
      await fileRequest(a.id as string);
      const rejected = await fileRequest(b.id as string);
      await request(app)
        .post(`${PREFIX}/admin/payments/${rejected}/reject`)
        .set('Authorization', auth)
        .send({ reason: 'Pul kelmadi' });

      const all = await request(app).get(`${PREFIX}/admin/payments?status=all`).set('Authorization', auth);
      expect(all.body.data.total).toBe(2);

      const failed = await request(app).get(`${PREFIX}/admin/payments?status=failed`).set('Authorization', auth);
      expect(failed.body.data.total).toBe(1);
      expect(failed.body.data.items[0].meta.rejectReason).toBe('Pul kelmadi');

      const byName = await request(app)
        .get(`${PREFIX}/admin/payments?status=all&search=sard`)
        .set('Authorization', auth);
      expect(byName.body.data.total).toBe(1);
      expect(byName.body.data.items[0].user.firstName).toBe('Sardor');

      const byPhone = await request(app)
        .get(`${PREFIX}/admin/payments`)
        .query({ status: 'all', search: b.phone.slice(-7) })
        .set('Authorization', auth);
      expect(byPhone.body.data.total).toBe(1);
    });

    it('counts pending requests', async () => {
      await fileRequest((await makeMaster()).id as string);
      await fileRequest((await makeMaster()).id as string);

      const response = await request(app)
        .get(`${PREFIX}/admin/payments/pending-count`)
        .set('Authorization', auth);
      expect(response.body.data).toEqual({ count: 2 });
    });
  });

  describe('POST /admin/payments/:id/approve', () => {
    it('credits the wallet, notifies the pro and writes the journal', async () => {
      const master = await makeMaster({ balance: 1_000 });
      const id = await fileRequest(master.id as string, 50_000);

      const response = await request(app)
        .post(`${PREFIX}/admin/payments/${id}/approve`)
        .set('Authorization', auth)
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.data.balance).toBe(51_000);
      expect(response.body.data.transaction).toMatchObject({
        id,
        status: 'success',
        amount: 50_000,
        balanceAfter: 51_000,
        meta: { approvedBy: adminId },
      });
      expect(response.body.data.transaction.settledAt).toEqual(expect.any(String));
      expect((await User.findById(master._id))!.balance).toBe(51_000);

      expect(
        await Notification.exists({ user: master._id, type: NotificationType.WALLET_TOPPED_UP }),
      ).toBeTruthy();
      expect(await AdminLog.exists({ action: AdminAction.PAYMENT_APPROVED })).toBeTruthy();
      expect(AdminAction.PAYMENT_APPROVED).toBe('payment_approved');

      // The pro may file a new request once the old one is settled.
      await fileRequest(master.id as string, 10_000);
    });

    it('credits an overridden amount when given', async () => {
      const master = await makeMaster({ balance: 0 });
      const id = await fileRequest(master.id as string, 50_000);

      const response = await request(app)
        .post(`${PREFIX}/admin/payments/${id}/approve`)
        .set('Authorization', auth)
        .send({ amount: 40_000 });

      expect(response.body.data.balance).toBe(40_000);
      expect(response.body.data.transaction.amount).toBe(40_000);
      expect(response.body.data.transaction.meta.requestedAmount).toBe(50_000);
    });

    it('cannot be approved twice (409 PAYMENT_NOT_PENDING)', async () => {
      const master = await makeMaster({ balance: 0 });
      const id = await fileRequest(master.id as string, 50_000);
      const approve = () =>
        request(app).post(`${PREFIX}/admin/payments/${id}/approve`).set('Authorization', auth).send({});

      expect((await approve()).status).toBe(200);
      const again = await approve();
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('PAYMENT_NOT_PENDING');
      expect((await User.findById(master._id))!.balance).toBe(50_000);
    });

    it('credits once when two approvals race', async () => {
      const master = await makeMaster({ balance: 0 });
      const id = await fileRequest(master.id as string, 50_000);

      const responses = await Promise.all(
        [0, 1, 2].map(() =>
          request(app).post(`${PREFIX}/admin/payments/${id}/approve`).set('Authorization', auth).send({}),
        ),
      );

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect((await User.findById(master._id))!.balance).toBe(50_000);
    });

    it('rejects an out-of-range override with 422', async () => {
      const master = await makeMaster();
      const id = await fileRequest(master.id as string);
      const response = await request(app)
        .post(`${PREFIX}/admin/payments/${id}/approve`)
        .set('Authorization', auth)
        .send({ amount: 500 });
      expect(response.status).toBe(422);
    });

    it('will not approve a non-manual transaction (404)', async () => {
      const master = await makeMaster({ balance: 0 });
      const payme = await Transaction.create({
        user: master._id,
        type: TransactionType.TOP_UP,
        status: TransactionStatus.PENDING,
        provider: PaymentProvider.PAYME,
        amount: 10_000,
      });
      const response = await request(app)
        .post(`${PREFIX}/admin/payments/${String(payme._id)}/approve`)
        .set('Authorization', auth)
        .send({});
      expect(response.status).toBe(404);
      expect((await User.findById(master._id))!.balance).toBe(0);
    });
  });

  describe('POST /admin/payments/:id/reject', () => {
    it('marks it failed with the reason and leaves the balance alone', async () => {
      const master = await makeMaster({ balance: 1_000 });
      const id = await fileRequest(master.id as string);

      const response = await request(app)
        .post(`${PREFIX}/admin/payments/${id}/reject`)
        .set('Authorization', auth)
        .send({ reason: 'Pul kelib tushmadi' });

      expect(response.status).toBe(200);
      expect(response.body.data.transaction).toMatchObject({
        id,
        status: 'failed',
        meta: { rejectReason: 'Pul kelib tushmadi' },
      });
      expect((await User.findById(master._id))!.balance).toBe(1_000);
      expect(
        await Notification.exists({
          user: master._id,
          type: NotificationType.WALLET_TOP_UP_REJECTED,
        }),
      ).toBeTruthy();
      expect(await AdminLog.exists({ action: 'payment_rejected' })).toBeTruthy();

      // Rejected requests show up in the pro's own history with the reason.
      const history = await request(app)
        .get(`${PREFIX}/wallet/transactions`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER));
      expect(history.body.data.items[0].meta.rejectReason).toBe('Pul kelib tushmadi');

      const approveAfter = await request(app)
        .post(`${PREFIX}/admin/payments/${id}/approve`)
        .set('Authorization', auth)
        .send({});
      expect(approveAfter.status).toBe(409);
    });

    it('requires a reason (422)', async () => {
      const master = await makeMaster();
      const id = await fileRequest(master.id as string);
      const response = await request(app)
        .post(`${PREFIX}/admin/payments/${id}/reject`)
        .set('Authorization', auth)
        .send({ reason: 'x' });
      expect(response.status).toBe(422);
    });
  });

  describe('POST /admin/users/:id/password', () => {
    it('sets a new password and signs the user out everywhere', async () => {
      const master = await makeMaster();
      const login = (password: string) =>
        request(app).post(`${PREFIX}/auth/login`).send({ phone: master.phone, password });

      const before = await login('secret123');
      expect(before.status).toBe(200);
      const oldToken = before.body.data.tokens?.accessToken ?? before.body.data.accessToken;

      // Tokens carry second-resolution `iat`; step past the current second so
      // the revocation cut-off is strictly after the old token was issued.
      await new Promise((resolve) => {
        setTimeout(resolve, 1_100);
      });

      const response = await request(app)
        .post(`${PREFIX}/admin/users/${master.id as string}/password`)
        .set('Authorization', auth)
        .send({ password: 'yangi-parol' });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ reset: true });
      expect((await login('secret123')).status).toBe(401);
      expect((await login('yangi-parol')).status).toBe(200);
      expect(await AdminLog.exists({ action: 'user_password_reset' })).toBeTruthy();

      if (oldToken) {
        const stale = await request(app).get(`${PREFIX}/wallet`).set('Authorization', `Bearer ${oldToken as string}`);
        expect(stale.status).toBe(401);
      }
    });

    it('validates the password length (422)', async () => {
      const master = await makeMaster();
      const response = await request(app)
        .post(`${PREFIX}/admin/users/${master.id as string}/password`)
        .set('Authorization', auth)
        .send({ password: '123' });
      expect(response.status).toBe(422);
    });

    it('refuses to reset another admin (403)', async () => {
      const other = await makeAdmin();
      const response = await request(app)
        .post(`${PREFIX}/admin/users/${other.id as string}/password`)
        .set('Authorization', auth)
        .send({ password: 'yangi-parol' });
      expect(response.status).toBe(403);
    });
  });

  describe('access', () => {
    it.each([
      ['GET', '/admin/payments'],
      ['GET', '/admin/payments/pending-count'],
      ['POST', '/admin/payments/507f1f77bcf86cd799439011/approve'],
      ['POST', '/admin/payments/507f1f77bcf86cd799439011/reject'],
      ['POST', '/admin/users/507f1f77bcf86cd799439011/password'],
    ])('refuses a master and a client: %s %s', async (method, path) => {
      const master = await makeMaster();
      const client = await makeClient();
      for (const token of [
        bearer(master.id as string, UserRole.MASTER),
        bearer(client.id as string, UserRole.CLIENT),
      ]) {
        const call =
          method === 'GET'
            ? request(app).get(`${PREFIX}${path}`)
            : request(app).post(`${PREFIX}${path}`).send({ reason: 'abc', password: 'abcdef' });
        // eslint-disable-next-line no-await-in-loop
        const response = await call.set('Authorization', token);
        expect(response.status).toBe(403);
      }
    });
  });
});
