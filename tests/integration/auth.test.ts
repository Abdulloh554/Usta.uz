import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { User } from '../../src/modules/user/user.model';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { Craft, UserRole } from '../../src/common/types';

const PREFIX = '/api/v1';

const clientPayload = {
  firstName: 'Dilnoza',
  lastName: 'Rahimova',
  phone: '+998901234567',
  password: 'secret123',
  confirmPassword: 'secret123',
  role: UserRole.CLIENT,
  acceptedRules: true,
};

describe('auth routes', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  describe('POST /auth/register', () => {
    it('creates a client and returns a session', async () => {
      const response = await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user.phone).toBe('+998901234567');
      expect(response.body.data.user.fullName).toBe('Dilnoza Rahimova');
      expect(response.body.data.user.initials).toBe('DR');
      expect(response.body.data.accessToken).toEqual(expect.any(String));
      expect(response.body.data.refreshToken).toEqual(expect.any(String));
    });

    it('never returns the password hash', async () => {
      const response = await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });

    it('sets the refresh token as an httpOnly cookie', async () => {
      const response = await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);
      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies.join(';')).toContain('ustauz_rt=');
      expect(cookies.join(';')).toContain('HttpOnly');
    });

    it('creates a trade profile alongside a pro account', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({
          ...clientPayload,
          phone: '+998945551234',
          role: UserRole.MASTER,
          crafts: [Craft.ELECTRICIAN, Craft.PLUMBER],
          about: '8 years of experience',
        });

      expect(response.status).toBe(201);
      const profile = await MasterProfile.findOne({ user: response.body.data.user.id });
      expect(profile).not.toBeNull();
      expect(profile!.crafts).toEqual([Craft.ELECTRICIAN, Craft.PLUMBER]);
    });

    it('rejects a pro who picked no trade', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, role: UserRole.MASTER, crafts: [] });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toContainEqual(
        expect.objectContaining({ field: 'crafts' }),
      );
    });

    it('rejects mismatched passwords', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, confirmPassword: 'different1' });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toContainEqual(
        expect.objectContaining({ field: 'confirmPassword' }),
      );
    });

    it('rejects a sign-up that does not accept the rules', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, acceptedRules: false });

      expect(response.status).toBe(422);
    });

    it('rejects an unknown operator code', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, phone: '+998121234567' });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toContainEqual(
        expect.objectContaining({ field: 'phone' }),
      );
    });

    it('refuses a phone number that is already registered', async () => {
      await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);
      const response = await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PHONE_TAKEN');
    });

    it('accepts a number written the way the design formats it', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, phone: '+998 90 123 45 67' });

      expect(response.status).toBe(201);
      // Stored canonically regardless of how it was typed.
      expect(response.body.data.user.phone).toBe('+998901234567');
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);
    });

    it('signs in with the right credentials', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ phone: clientPayload.phone, password: clientPayload.password });

      expect(response.status).toBe(200);
      expect(response.body.data.accessToken).toEqual(expect.any(String));
    });

    it('rejects a wrong password without saying which field was wrong', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ phone: clientPayload.phone, password: 'wrong-password' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('gives an unknown number the same answer as a wrong password', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ phone: '+998909999999', password: 'secret123' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses a blocked account and says why', async () => {
      await User.updateOne(
        { phone: clientPayload.phone },
        { $set: { isBlocked: true, blockReason: 'Repeated false jobs' } },
      );

      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ phone: clientPayload.phone, password: clientPayload.password });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Repeated false jobs');
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the pair and invalidates the token it replaced', async () => {
      const registered = await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);
      const first = registered.body.data.refreshToken as string;

      const refreshed = await request(app).post(`${PREFIX}/auth/refresh`).send({ refreshToken: first });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.data.refreshToken).not.toBe(first);

      // Replaying the old token is treated as theft.
      const replay = await request(app).post(`${PREFIX}/auth/refresh`).send({ refreshToken: first });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('TOKEN_REVOKED');
    });

    it('drops every session when a revoked token is replayed', async () => {
      const registered = await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);
      const first = registered.body.data.refreshToken as string;

      const refreshed = await request(app).post(`${PREFIX}/auth/refresh`).send({ refreshToken: first });
      const second = refreshed.body.data.refreshToken as string;

      await request(app).post(`${PREFIX}/auth/refresh`).send({ refreshToken: first });

      // The replay took the whole family down, including the current token.
      const afterBreach = await request(app)
        .post(`${PREFIX}/auth/refresh`)
        .send({ refreshToken: second });
      expect(afterBreach.status).toBe(401);
    });

    it('rejects a request with no token at all', async () => {
      const response = await request(app).post(`${PREFIX}/auth/refresh`).send({});
      expect(response.status).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the signed-in user', async () => {
      const registered = await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);

      const response = await request(app)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', `Bearer ${registered.body.data.accessToken as string}`);

      expect(response.status).toBe(200);
      expect(response.body.data.phone).toBe('+998901234567');
    });

    it('rejects a missing token', async () => {
      const response = await request(app).get(`${PREFIX}/auth/me`);
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('TOKEN_MISSING');
    });

    it('rejects a garbage token', async () => {
      const response = await request(app)
        .get(`${PREFIX}/auth/me`)
        .set('Authorization', 'Bearer not-a-real-token');
      expect(response.status).toBe(401);
    });
  });

  describe('POST /auth/check-phone', () => {
    it('names the operator for a valid number', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/check-phone`)
        .send({ phone: '+998901234567' });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        valid: true,
        operator: 'Beeline',
        registered: false,
        formatted: '+998 90 123 45 67',
      });
    });

    it('reports an unknown operator code as invalid', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/check-phone`)
        .send({ phone: '+998121234567' });

      expect(response.body.data.valid).toBe(false);
      expect(response.body.data.operator).toBeNull();
    });

    it('reports a number that already has an account', async () => {
      await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);

      const response = await request(app)
        .post(`${PREFIX}/auth/check-phone`)
        .send({ phone: clientPayload.phone });

      expect(response.body.data.registered).toBe(true);
    });
  });

  describe('password reset', () => {
    it('reports success for an unknown number, so numbers cannot be enumerated', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/forgot-password`)
        .send({ phone: '+998909999999' });

      expect(response.status).toBe(200);
      expect(response.body.data.sent).toBe(true);
    });

    it('rejects a wrong code', async () => {
      await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);
      await request(app).post(`${PREFIX}/auth/forgot-password`).send({ phone: clientPayload.phone });

      const response = await request(app).post(`${PREFIX}/auth/reset-password`).send({
        phone: clientPayload.phone,
        code: '000000',
        password: 'newsecret1',
        confirmPassword: 'newsecret1',
      });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CODE');
    });
  });

  it('answers an unknown route with a structured 404', async () => {
    const response = await request(app).get(`${PREFIX}/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('reports health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
  });
});
