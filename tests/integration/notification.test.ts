import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { User } from '../../src/modules/user/user.model';
import { UserRole } from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { WEB_PUSH_PREFIX } from '../../src/config/push';
import { makeMaster } from '../helpers/factories';

const PREFIX = '/api/v1';

const webToken = (endpoint: string): string =>
  `${WEB_PUSH_PREFIX}${Buffer.from(
    JSON.stringify({ endpoint, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' } }),
  ).toString('base64url')}`;

describe('notification devices', () => {
  let app: Express;
  let auth: string;
  let userId: string;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(async () => {
    const user = await makeMaster();
    userId = user.id as string;
    auth = `Bearer ${issueTokenPair(userId, UserRole.MASTER).accessToken}`;
  });

  it('stores a browser subscription from a real push service', async () => {
    const token = webToken('https://fcm.googleapis.com/fcm/send/abc:def');
    const response = await request(app).post(`${PREFIX}/notifications/devices`).set('Authorization', auth).send({ token });

    expect(response.status).toBe(200);
    const user = await User.findById(userId).select('pushTokens').lean();
    expect(user?.pushTokens).toContain(token);
  });

  it('refuses a subscription that points anywhere else', async () => {
    const token = webToken('https://10.0.0.5/internal');
    const response = await request(app).post(`${PREFIX}/notifications/devices`).set('Authorization', auth).send({ token });

    expect(response.status).toBe(422);
    const user = await User.findById(userId).select('pushTokens').lean();
    expect(user?.pushTokens ?? []).not.toContain(token);
  });

  it('still keeps phone tokens to their old length limit', async () => {
    const response = await request(app)
      .post(`${PREFIX}/notifications/devices`)
      .set('Authorization', auth)
      .send({ token: 'x'.repeat(600) });

    expect(response.status).toBe(422);
  });

  it('serves the public key, or null while browser push is off', async () => {
    const response = await request(app).get(`${PREFIX}/notifications/web-push/key`).set('Authorization', auth);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ publicKey: null });
  });
});
