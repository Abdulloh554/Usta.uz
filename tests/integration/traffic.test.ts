import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { Visit } from '../../src/modules/traffic/traffic.model';
import { User } from '../../src/modules/user/user.model';
import { UserRole } from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { nextPhone } from '../helpers/factories';

const app = createApp();
const body = () => ({
  visitorId: randomUUID(),
  sessionId: randomUUID(),
  site: 'web',
  url: 'https://ustamiz.uz/uz/client',
  referrer: 'https://www.google.com/search?q=ustamiz',
});
const reportUrl = '/api/v1/admin/stats/traffic';
async function adminToken() {
  const admin = await User.create({
    phone: nextPhone(),
    passwordHash: 'secret',
    firstName: 'Test',
    lastName: 'Admin',
    role: UserRole.ADMIN,
    acceptedRulesAt: new Date(),
  });
  return `Bearer ${issueTokenPair(admin.id as string, UserRole.ADMIN).accessToken}`;
}

describe('website traffic', () => {
  it('records anonymous Google visits and deduplicates concurrent retries', async () => {
    const entry = body();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post('/api/v1/traffic/visits').send(entry)),
    );
    expect(responses.map((res) => res.status)).toEqual([204, 204, 204]);
    expect(await Visit.countDocuments()).toBe(1);
    expect(await Visit.findOne()).toMatchObject({
      source: 'google',
      referrerHost: 'www.google.com',
      path: '/uz/client',
    });
  });

  it.each([
    ['https://google.com.evil.test/path', '', 'link'],
    ['https://t.me/ustamiz', '', 'link'],
    ['', '?utm_source=telegram&utm_campaign=launch', 'link'],
    ['', '?utm_source=google', 'google'],
    ['', '?gclid=ad-click', 'google'],
    ['https://ustamiz.uz/previous', '', 'direct'],
    ['', '', 'direct'],
  ])('classifies referrer %s with tags %s', async (referrer, tags, source) => {
    await request(app)
      .post('/api/v1/traffic/visits')
      .send({ ...body(), url: `https://ustamiz.uz/uz${tags}`, referrer })
      .expect(204);
    expect(await Visit.findOne()).toMatchObject({ source, path: '/uz' });
  });

  it('ignores known crawlers and validates untrusted input', async () => {
    await request(app)
      .post('/api/v1/traffic/visits')
      .set('User-Agent', 'Googlebot')
      .send(body())
      .expect(204);
    await request(app)
      .post('/api/v1/traffic/visits')
      .send({ ...body(), visitorId: 'invalid' })
      .expect(422);
    await request(app)
      .post('/api/v1/traffic/visits')
      .send({ ...body(), url: 'ftp://example.com' })
      .expect(422);
    expect(await Visit.countDocuments()).toBe(0);
  });

  it('requires admin authorization and rejects impossible dates', async () => {
    await request(app).get(reportUrl).expect(401);
    const token = await adminToken();
    await request(app).get(`${reportUrl}?date=2026-02-30`).set('Authorization', token).expect(422);
  });

  it('counts distinct browsers and visits by Toshkent hour, filters and paginates entries', async () => {
    const visitorId = randomUUID();
    const make = (createdAt: string, source = 'google', site = 'web', visitor = visitorId) => ({
      visitorId: visitor,
      sessionId: randomUUID(),
      site,
      source,
      path: '/uz',
      createdAt: new Date(createdAt),
    });
    await Visit.insertMany([
      make('2026-10-09T18:59:59Z'), // Previous day in Tashkent.
      make('2026-10-09T19:00:00Z'), // Midnight.
      make('2026-10-09T19:45:00Z'), // Same browser, another session in the same hour.
      make('2026-10-10T04:30:00Z', 'link'), // 09:30, same browser.
      make('2026-10-10T18:59:59Z', 'direct', 'landing', randomUUID()),
      make('2026-10-10T19:00:00Z'), // Next day in Tashkent.
    ]);
    const token = await adminToken();
    const response = await request(app)
      .get(`${reportUrl}?date=2026-10-10&limit=1&page=2`)
      .set('Authorization', token)
      .expect(200);
    const { data } = response.body as {
      data: { totals: unknown; hours: unknown[]; entries: { items: unknown[] } };
    };
    expect(data.totals).toEqual({ visits: 4, visitors: 2 });
    expect(data.hours).toHaveLength(24);
    expect(data.hours[0]).toMatchObject({ visits: 2, visitors: 1, google: 1 });
    expect(data.hours[9]).toMatchObject({ visits: 1, link: 1 });
    expect(data.hours[23]).toMatchObject({ visits: 1, direct: 1 });
    expect(data.entries).toMatchObject({ page: 2, total: 4, pages: 4 });
    expect(data.entries.items).toHaveLength(1);
    const filtered = await request(app)
      .get(`${reportUrl}?date=2026-10-10&site=web&source=link`)
      .set('Authorization', token)
      .expect(200);
    expect(filtered.body.data.totals).toEqual({ visits: 1, visitors: 1 });
  });

  it('returns a complete empty day', async () => {
    const response = await request(app)
      .get(`${reportUrl}?date=2026-10-10`)
      .set('Authorization', await adminToken())
      .expect(200);
    expect(response.body.data.totals).toEqual({ visits: 0, visitors: 0 });
    const { data } = response.body as { data: { hours: Array<{ visits: number }> } };
    expect(data.hours.every((hour) => hour.visits === 0)).toBe(true);
    expect(response.body.data.entries.items).toEqual([]);
  });
});
