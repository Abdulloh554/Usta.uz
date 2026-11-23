import request from 'supertest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';

/**
 * A browser origin outside CORS_ORIGINS must be refused as 403, not crash the
 * request into a 500 that pages someone for nothing.
 */
describe('CORS origin allow-list', () => {
  const app = createApp();
  const original = [...env.CORS_ORIGINS];

  beforeAll(() => {
    env.CORS_ORIGINS.splice(0, env.CORS_ORIGINS.length, 'https://www.ustamiz.uz');
  });

  afterAll(() => {
    env.CORS_ORIGINS.splice(0, env.CORS_ORIGINS.length, ...original);
  });

  it('allows a listed origin', async () => {
    const res = await request(app).get('/api/v1/nope').set('Origin', 'https://www.ustamiz.uz');
    expect(res.status).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBe('https://www.ustamiz.uz');
  });

  it('allows requests with no Origin header (native app, server-to-server)', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(404);
  });

  it('answers an unlisted origin with 403, not 500', async () => {
    const res = await request(app).get('/api/v1/nope').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CORS_ORIGIN_NOT_ALLOWED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers an unlisted preflight with 403', async () => {
    const res = await request(app)
      .options('/api/v1/auth/register')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
  });
});
