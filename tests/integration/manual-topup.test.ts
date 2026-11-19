import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { Transaction } from '../../src/modules/wallet/transaction.model';
import { User } from '../../src/modules/user/user.model';
import {
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { makeClient, makeMaster, makeSeller } from '../helpers/factories';

const PREFIX = '/api/v1';

const bearer = (id: string, role: UserRole): string =>
  `Bearer ${issueTokenPair(id, role).accessToken}`;

/** `env` is parsed once at boot; tests flip the few values they exercise and restore them. */
const settings = env as unknown as Record<string, string | number>;

const withEnv = (overrides: Record<string, string | number>): void => {
  const original: Record<string, string | number> = {};
  beforeEach(() => {
    Object.entries(overrides).forEach(([key, value]) => {
      original[key] = settings[key] as string | number;
      settings[key] = value;
    });
  });
  afterEach(() => {
    Object.entries(original).forEach(([key, value]) => {
      settings[key] = value;
    });
  });
};

describe('manual top-ups (pro side)', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  describe('GET /wallet', () => {
    withEnv({ MANUAL_PAYMENT_CARD: '8600 1234 5678 9012', MANUAL_PAYMENT_HOLDER: 'ALIYEV ALI' });

    it('returns the card details and no pending request', async () => {
      const master = await makeMaster({ balance: 7_000 });
      const response = await request(app)
        .get(`${PREFIX}/wallet`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER));

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        balance: 7_000,
        fee: 4999,
        manualPayment: { card: '8600 1234 5678 9012', holder: 'ALIYEV ALI', note: '' },
        pendingTopUp: null,
      });
    });

    it('shows the request that is waiting for review', async () => {
      const master = await makeMaster();
      const auth = bearer(master.id as string, UserRole.MASTER);
      const created = await request(app)
        .post(`${PREFIX}/wallet/top-up-requests`)
        .set('Authorization', auth)
        .send({ amount: 50_000, payerNote: 'Karta oxiri 1234, Ali Valiyev' });

      const response = await request(app).get(`${PREFIX}/wallet`).set('Authorization', auth);
      expect(response.body.data.pendingTopUp).toMatchObject({
        id: created.body.data.id,
        amount: 50_000,
      });
      expect(typeof response.body.data.pendingTopUp.createdAt).toBe('string');
    });
  });

  describe('POST /wallet/top-up-requests', () => {
    it('records a pending manual top-up without moving the balance', async () => {
      const master = await makeMaster({ balance: 1_000 });
      const response = await request(app)
        .post(`${PREFIX}/wallet/top-up-requests`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER))
        .send({ amount: 50_000, payerNote: '  Karta oxiri 1234  ' });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ amount: 50_000, status: 'pending' });
      expect(response.body.data.id).toEqual(expect.any(String));

      const transaction = await Transaction.findById(response.body.data.id).lean();
      expect(transaction).toMatchObject({
        type: TransactionType.TOP_UP,
        status: TransactionStatus.PENDING,
        provider: PaymentProvider.MANUAL,
        amount: 50_000,
        meta: { payerNote: 'Karta oxiri 1234' },
      });
      expect((await User.findById(master._id))!.balance).toBe(1_000);
    });

    it('allows sellers too', async () => {
      const seller = await makeSeller();
      const response = await request(app)
        .post(`${PREFIX}/wallet/top-up-requests`)
        .set('Authorization', bearer(seller.id as string, UserRole.SELLER))
        .send({ amount: 10_000, payerNote: 'Karta 9999' });
      expect(response.status).toBe(201);
    });

    it('refuses a second request while one is pending (409 TOP_UP_PENDING)', async () => {
      const master = await makeMaster();
      const auth = bearer(master.id as string, UserRole.MASTER);
      const body = { amount: 20_000, payerNote: 'Karta oxiri 1234' };

      expect((await request(app).post(`${PREFIX}/wallet/top-up-requests`).set('Authorization', auth).send(body)).status).toBe(201);
      const second = await request(app)
        .post(`${PREFIX}/wallet/top-up-requests`)
        .set('Authorization', auth)
        .send(body);

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('TOP_UP_PENDING');
      expect(await Transaction.countDocuments({ user: master._id })).toBe(1);
    });

    it('keeps one pending request even when two race', async () => {
      const master = await makeMaster();
      const auth = bearer(master.id as string, UserRole.MASTER);
      const body = { amount: 20_000, payerNote: 'Karta oxiri 1234' };

      const responses = await Promise.all(
        [0, 1, 2].map(() =>
          request(app).post(`${PREFIX}/wallet/top-up-requests`).set('Authorization', auth).send(body),
        ),
      );

      expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(2);
      expect(await Transaction.countDocuments({ user: master._id })).toBe(1);
    });

    it('rejects a client (403)', async () => {
      const client = await makeClient();
      const response = await request(app)
        .post(`${PREFIX}/wallet/top-up-requests`)
        .set('Authorization', bearer(client.id as string, UserRole.CLIENT))
        .send({ amount: 20_000, payerNote: 'Karta oxiri 1234' });
      expect(response.status).toBe(403);
    });

    it.each([
      [{ amount: 999, payerNote: 'Karta 1234' }],
      [{ amount: 10_000_001, payerNote: 'Karta 1234' }],
      [{ amount: 1500.5, payerNote: 'Karta 1234' }],
      [{ amount: 5_000, payerNote: '  ab ' }],
      [{ amount: 5_000, payerNote: 'x'.repeat(201) }],
      [{ amount: 5_000 }],
    ])('rejects an invalid body with 422: %j', async (body) => {
      const master = await makeMaster();
      const response = await request(app)
        .post(`${PREFIX}/wallet/top-up-requests`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER))
        .send(body);
      expect(response.status).toBe(422);
    });

    describe('with payments turned off', () => {
      withEnv({ ORDER_ACCEPT_FEE: 0 });

      it('refuses with 403 PAYMENTS_DISABLED', async () => {
        const master = await makeMaster();
        const response = await request(app)
          .post(`${PREFIX}/wallet/top-up-requests`)
          .set('Authorization', bearer(master.id as string, UserRole.MASTER))
          .send({ amount: 20_000, payerNote: 'Karta oxiri 1234' });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('PAYMENTS_DISABLED');
      });
    });
  });

  describe('online providers without keys', () => {
    withEnv({ PAYME_KEY: '', PAYME_MERCHANT_ID: '', CLICK_SECRET_KEY: '', CLICK_MERCHANT_ID: '' });

    it('POST /wallet/top-up refuses with 403 PROVIDER_UNAVAILABLE', async () => {
      const master = await makeMaster();
      const response = await request(app)
        .post(`${PREFIX}/wallet/top-up`)
        .set('Authorization', bearer(master.id as string, UserRole.MASTER))
        .send({ amount: 20_000, provider: 'payme' });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    });

    it('rejects a Payme callback with an empty password when PAYME_KEY is unset', async () => {
      const master = await makeMaster({ balance: 0 });
      const transaction = await Transaction.create({
        user: master._id,
        type: TransactionType.TOP_UP,
        status: TransactionStatus.PENDING,
        provider: PaymentProvider.PAYME,
        amount: 20_000,
        externalId: 'payme-1',
      });

      const response = await request(app)
        .post(`${PREFIX}/wallet/callback/payme`)
        .set('Authorization', `Basic ${Buffer.from('Paycom:').toString('base64')}`)
        .send({ id: 1, method: 'PerformTransaction', params: { id: 'payme-1' } });

      expect(response.status).toBe(200);
      expect(response.body.error.code).toBe(-32504);
      expect((await Transaction.findById(transaction._id))!.status).toBe(TransactionStatus.PENDING);
      expect((await User.findById(master._id))!.balance).toBe(0);
    });

    it('rejects a Click callback when CLICK_SECRET_KEY is unset', async () => {
      const crypto = await import('node:crypto');
      const master = await makeMaster({ balance: 0 });
      const transaction = await Transaction.create({
        user: master._id,
        type: TransactionType.TOP_UP,
        status: TransactionStatus.PENDING,
        provider: PaymentProvider.CLICK,
        amount: 20_000,
      });
      const fields = {
        click_trans_id: '1',
        service_id: '2',
        merchant_trans_id: String(transaction._id),
        amount: '20000',
        action: '1',
        sign_time: '2026-01-01 00:00:00',
      };
      // Signed with the empty secret — exactly what a forger would do.
      const sign = crypto
        .createHash('md5')
        .update(
          [fields.click_trans_id, fields.service_id, '', fields.merchant_trans_id, fields.amount, fields.action, fields.sign_time].join(''),
        )
        .digest('hex');

      const response = await request(app)
        .post(`${PREFIX}/wallet/callback/click`)
        .send({ ...fields, sign_string: sign, error: '0' });

      expect(response.body.error).toBe(-1);
      expect((await User.findById(master._id))!.balance).toBe(0);
    });
  });

  describe('Click completion checks', () => {
    withEnv({ CLICK_SECRET_KEY: 'click-secret', CLICK_MERCHANT_ID: 'm', CLICK_SERVICE_ID: '2' });

    const signed = async (fields: Record<string, string>): Promise<Record<string, string>> => {
      const crypto = await import('node:crypto');
      const sign = crypto
        .createHash('md5')
        .update(
          [fields.click_trans_id, fields.service_id, 'click-secret', fields.merchant_trans_id, fields.amount, fields.action, fields.sign_time].join(''),
        )
        .digest('hex');
      return { ...fields, sign_string: sign };
    };

    const pendingClick = async (userId: unknown) =>
      Transaction.create({
        user: userId,
        type: TransactionType.TOP_UP,
        status: TransactionStatus.PENDING,
        provider: PaymentProvider.CLICK,
        amount: 20_000,
      });

    const base = (merchantTransId: string, amount: string) => ({
      click_trans_id: '777',
      service_id: '2',
      merchant_trans_id: merchantTransId,
      amount,
      action: '1',
      sign_time: '2026-01-01 00:00:00',
    });

    it('does not credit when the amount differs from the transaction', async () => {
      const master = await makeMaster({ balance: 0 });
      const transaction = await pendingClick(master._id);
      const response = await request(app)
        .post(`${PREFIX}/wallet/callback/click`)
        .send({ ...(await signed(base(String(transaction._id), '200000'))), error: '0' });

      expect(response.body.error).toBe(-2);
      expect((await User.findById(master._id))!.balance).toBe(0);
    });

    it('does not credit when Click reports a negative error', async () => {
      const master = await makeMaster({ balance: 0 });
      const transaction = await pendingClick(master._id);
      const response = await request(app)
        .post(`${PREFIX}/wallet/callback/click`)
        .send({ ...(await signed(base(String(transaction._id), '20000'))), error: '-5017' });

      expect(response.body.error).toBe(-9);
      expect((await User.findById(master._id))!.balance).toBe(0);
      expect((await Transaction.findById(transaction._id))!.status).toBe(TransactionStatus.FAILED);
    });

    it('credits a valid completion once', async () => {
      const master = await makeMaster({ balance: 0 });
      const transaction = await pendingClick(master._id);
      const body = { ...(await signed(base(String(transaction._id), '20000.00'))), error: '0' };

      const first = await request(app).post(`${PREFIX}/wallet/callback/click`).send(body);
      await request(app).post(`${PREFIX}/wallet/callback/click`).send(body);

      expect(first.body.error).toBe(0);
      expect((await User.findById(master._id))!.balance).toBe(20_000);
    });

    it('never settles a manual request through a provider callback', async () => {
      const master = await makeMaster({ balance: 0 });
      const manual = await Transaction.create({
        user: master._id,
        type: TransactionType.TOP_UP,
        status: TransactionStatus.PENDING,
        provider: PaymentProvider.MANUAL,
        amount: 20_000,
      });
      const response = await request(app)
        .post(`${PREFIX}/wallet/callback/click`)
        .send({ ...(await signed(base(String(manual._id), '20000'))), error: '0' });

      expect(response.body.error).toBe(-5);
      expect((await User.findById(master._id))!.balance).toBe(0);
    });
  });
});
