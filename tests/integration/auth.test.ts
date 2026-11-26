import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { User } from '../../src/modules/user/user.model';
import { MasterProfile } from '../../src/modules/user/masterProfile.model';
import { Craft, UserRole } from '../../src/common/types';
import { mailProvider } from '../../src/config/mail';
import { requestCode, signInWithCode, signUp } from '../helpers/otp';

const PREFIX = '/api/v1';

const clientPayload = {
  firstName: 'Dilnoza',
  lastName: 'Rahimova',
  email: 'dilnoza@example.com',
  phone: '+998901234567',
  role: UserRole.CLIENT,
  acceptedRules: true,
};

describe('auth routes', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  describe('POST /auth/register/request', () => {
    it('mails a six-digit code to the address', async () => {
      const { status, code } = await requestCode(app, '/auth/register/request', {
        email: clientPayload.email,
        phone: clientPayload.phone,
      });

      expect(status).toBe(200);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('refuses an email that already has an account, whatever its case', async () => {
      await signUp(app, clientPayload);

      const response = await request(app)
        .post(`${PREFIX}/auth/register/request`)
        .send({ email: 'Dilnoza@Example.com', phone: '+998909876543' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('EMAIL_TAKEN');
    });

    it('refuses a phone number that already has an account', async () => {
      await signUp(app, clientPayload);

      const response = await request(app)
        .post(`${PREFIX}/auth/register/request`)
        .send({ email: 'other@example.com', phone: clientPayload.phone });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PHONE_TAKEN');
    });

    it('rejects an unknown operator code and a malformed email', async () => {
      const badPhone = await request(app)
        .post(`${PREFIX}/auth/register/request`)
        .send({ email: clientPayload.email, phone: '+998121234567' });
      expect(badPhone.status).toBe(422);

      const badEmail = await request(app)
        .post(`${PREFIX}/auth/register/request`)
        .send({ email: 'not-an-email', phone: clientPayload.phone });
      expect(badEmail.status).toBe(422);
    });
  });

  describe('POST /auth/register', () => {
    it('creates a client with the emailed code and returns a session', async () => {
      const response = await signUp(app, clientPayload);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user.phone).toBe('+998901234567');
      expect(response.body.data.user.email).toBe('dilnoza@example.com');
      expect(response.body.data.user.fullName).toBe('Dilnoza Rahimova');
      expect(response.body.data.user.initials).toBe('DR');
      expect(response.body.data.accessToken).toEqual(expect.any(String));
      expect(response.body.data.refreshToken).toEqual(expect.any(String));
    });

    it('stores no password for the account', async () => {
      await signUp(app, clientPayload);
      const user = await User.findOne({ email: clientPayload.email }).select('+passwordHash');
      expect(user!.passwordHash).toBeUndefined();
    });

    it('refuses a wrong code and creates nothing', async () => {
      await requestCode(app, '/auth/register/request', {
        email: clientPayload.email,
        phone: clientPayload.phone,
      });

      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, code: '000000' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CODE');
      expect(await User.countDocuments({ email: clientPayload.email })).toBe(0);
    });

    it('refuses a sign-up without a code', async () => {
      const response = await request(app).post(`${PREFIX}/auth/register`).send(clientPayload);
      expect(response.status).toBe(422);
      expect(response.body.error.details).toContainEqual(expect.objectContaining({ field: 'code' }));
    });

    it('will not take the same code twice', async () => {
      const { code } = await requestCode(app, '/auth/register/request', {
        email: clientPayload.email,
        phone: clientPayload.phone,
      });
      const first = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, code });
      expect(first.status).toBe(201);

      await User.deleteMany({});
      const replay = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, code });
      expect(replay.status).toBe(401);
    });

    it('burns the code after too many wrong guesses', async () => {
      const { code } = await requestCode(app, '/auth/register/request', {
        email: clientPayload.email,
        phone: clientPayload.phone,
      });
      for (let i = 0; i < 5; i += 1) {
        await request(app)
          .post(`${PREFIX}/auth/register`)
          .send({ ...clientPayload, code: code === '111111' ? '222222' : '111111' });
      }

      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...clientPayload, code });
      expect(response.status).toBe(429);
    });

    it('never returns a password hash', async () => {
      const response = await signUp(app, clientPayload);
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });

    it('sets the refresh token as an httpOnly cookie', async () => {
      const response = await signUp(app, clientPayload);
      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies.join(';')).toContain('ustauz_rt=');
      expect(cookies.join(';')).toContain('HttpOnly');
    });

    it('creates a trade profile alongside a pro account', async () => {
      const response = await signUp(app, {
        ...clientPayload,
        email: 'usta@example.com',
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
      const response = await signUp(app, { ...clientPayload, role: UserRole.MASTER, crafts: [] });

      expect(response.status).toBe(422);
      expect(response.body.error.details).toContainEqual(
        expect.objectContaining({ field: 'crafts' }),
      );
    });

    it('rejects a sign-up that does not accept the rules', async () => {
      const response = await signUp(app, { ...clientPayload, acceptedRules: false });
      expect(response.status).toBe(422);
    });

    it('accepts a number written the way the design formats it', async () => {
      const response = await signUp(app, { ...clientPayload, phone: '+998 90 123 45 67' });

      expect(response.status).toBe(201);
      // Stored canonically regardless of how it was typed.
      expect(response.body.data.user.phone).toBe('+998901234567');
    });

    /**
     * 99 830 38 23 is a real Uzmobile number whose national part starts with the
     * country code. Its digits were stripped twice, so sign-up answered
     * "Validation failed" — the whole flow is covered here, not just the rule.
     */
    it('signs up a number whose national part starts with 998', async () => {
      const created = await signUp(app, { ...clientPayload, phone: '+998 99 830 38 23' });

      expect(created.status).toBe(201);
      expect(created.body.data.user.phone).toBe('+998998303823');
    });
  });

  describe('POST /auth/register (phone and password)', () => {
    // Only ever sent as JSON, which leaves an undefined field out: no email at all.
    const phonePayload = { ...clientPayload, email: undefined };
    const withPassword = { ...phonePayload, password: 'secret123' };

    it('creates an account with no email and no code, mailing nothing', async () => {
      const send = jest.spyOn(mailProvider, 'send');
      const response = await request(app).post(`${PREFIX}/auth/register`).send(withPassword);

      expect(response.status).toBe(201);
      expect(response.body.data.user.phone).toBe(clientPayload.phone);
      expect(response.body.data.user.email).toBeUndefined();
      expect(response.body.data.accessToken).toEqual(expect.any(String));
      expect(send).not.toHaveBeenCalled();
      send.mockRestore();
    });

    it('then signs in by phone and password, and stores only a hash', async () => {
      await request(app).post(`${PREFIX}/auth/register`).send(withPassword);

      const stored = await User.findOne({ phone: clientPayload.phone }).select('+passwordHash');
      expect(stored?.passwordHash).toMatch(/^\$2[aby]\$/);

      const login = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ phone: clientPayload.phone, password: 'secret123' });
      expect(login.status).toBe(200);
    });

    it('refuses a phone number that already has an account', async () => {
      await request(app).post(`${PREFIX}/auth/register`).send(withPassword);
      const response = await request(app).post(`${PREFIX}/auth/register`).send(withPassword);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PHONE_TAKEN');
    });

    it('rejects a password shorter than six characters', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/register`)
        .send({ ...withPassword, password: '123' });

      expect(response.status).toBe(422);
      expect(await User.countDocuments()).toBe(0);
    });

    it('rejects a sign-up with neither a password nor a code', async () => {
      const response = await request(app).post(`${PREFIX}/auth/register`).send(phonePayload);

      expect(response.status).toBe(422);
      expect(await User.countDocuments()).toBe(0);
    });
  });

  describe('POST /auth/login (emailed code)', () => {
    beforeEach(async () => {
      await signUp(app, clientPayload);
    });

    it('signs in with the code mailed to the address', async () => {
      const response = await signInWithCode(app, clientPayload.email);

      expect(response.status).toBe(200);
      expect(response.body.data.accessToken).toEqual(expect.any(String));
      expect(response.body.data.user.phone).toBe('+998901234567');
    });

    it('treats the email case-insensitively', async () => {
      const response = await signInWithCode(app, '  DILNOZA@Example.COM ');
      expect(response.status).toBe(200);
    });

    it('answers a code request for an unknown address the same, and mails nothing', async () => {
      const { status, code } = await requestCode(app, '/auth/login/request', {
        email: 'nobody@example.com',
      });

      expect(status).toBe(200);
      expect(code).toBeNull();
    });

    it('rejects a wrong code', async () => {
      await requestCode(app, '/auth/login/request', { email: clientPayload.email });

      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: clientPayload.email, code: '000000' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CODE');
    });

    it('gives an unknown address the same answer as a wrong code', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: 'nobody@example.com', code: '123456' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CODE');
    });

    it('rejects a login with neither a code nor a password', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: clientPayload.email });

      expect(response.status).toBe(422);
    });

    it('refuses a blocked account and says why', async () => {
      await User.updateOne(
        { email: clientPayload.email },
        { $set: { isBlocked: true, blockReason: 'Repeated false jobs' } },
      );
      // A blocked account gets no code at all.
      const { code } = await requestCode(app, '/auth/login/request', { email: clientPayload.email });
      expect(code).toBeNull();
    });

    it('cannot be signed into with a password, since it has none', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: clientPayload.email, password: 'anything' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /auth/login (password: admins and older accounts)', () => {
    beforeEach(async () => {
      await User.create({
        phone: '+998901234567',
        email: 'legacy@example.com',
        passwordHash: 'secret123',
        firstName: 'Eski',
        lastName: 'Hisob',
        role: UserRole.CLIENT,
        acceptedRulesAt: new Date(),
      });
    });

    it('still signs in with email and password', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: 'legacy@example.com', password: 'secret123' });

      expect(response.status).toBe(200);
    });

    it('still lets an account without an email sign in by phone', async () => {
      await User.updateOne({ phone: '+998901234567' }, { $unset: { email: 1 } });

      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ phone: '+998901234567', password: 'secret123' });

      expect(response.status).toBe(200);
    });

    it('rejects a wrong password without saying which field was wrong', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: 'legacy@example.com', password: 'wrong-password' });

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('refuses a blocked account and says why', async () => {
      await User.updateOne(
        { email: 'legacy@example.com' },
        { $set: { isBlocked: true, blockReason: 'Repeated false jobs' } },
      );

      const response = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: 'legacy@example.com', password: 'secret123' });

      expect(response.status).toBe(403);
      expect(response.body.error.message).toBe('Repeated false jobs');
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the pair and invalidates the token it replaced', async () => {
      const registered = await signUp(app, clientPayload);
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
      const registered = await signUp(app, clientPayload);
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
      const registered = await signUp(app, clientPayload);

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
      await signUp(app, clientPayload);

      const response = await request(app)
        .post(`${PREFIX}/auth/check-phone`)
        .send({ phone: clientPayload.phone });

      expect(response.body.data.registered).toBe(true);
    });
  });

  describe('password reset (accounts that have a password)', () => {
    it('reports success for an unknown email, so addresses cannot be enumerated', async () => {
      const response = await request(app)
        .post(`${PREFIX}/auth/forgot-password`)
        .send({ email: 'nobody@example.com' });

      expect(response.status).toBe(200);
      expect(response.body.data.sent).toBe(true);
    });

    it('emails a code, then lets the new password in and the old one out', async () => {
      await User.create({
        phone: '+998901234567',
        email: 'legacy@example.com',
        passwordHash: 'secret123',
        firstName: 'Eski',
        lastName: 'Hisob',
        role: UserRole.CLIENT,
        acceptedRulesAt: new Date(),
      });

      const sent: string[] = [];
      const spy = jest.spyOn(mailProvider, 'send').mockImplementation(async (message) => {
        sent.push(message.text);
      });
      await request(app).post(`${PREFIX}/auth/forgot-password`).send({ email: 'LEGACY@example.com' });
      spy.mockRestore();

      const code = /(\d{6})/.exec(sent[0]!)![1]!;
      const reset = await request(app).post(`${PREFIX}/auth/reset-password`).send({
        email: 'legacy@example.com',
        code,
        password: 'newsecret1',
        confirmPassword: 'newsecret1',
      });
      expect(reset.status).toBe(200);

      const fresh = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: 'legacy@example.com', password: 'newsecret1' });
      expect(fresh.status).toBe(200);

      const stale = await request(app)
        .post(`${PREFIX}/auth/login`)
        .send({ email: 'legacy@example.com', password: 'secret123' });
      expect(stale.status).toBe(401);
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
