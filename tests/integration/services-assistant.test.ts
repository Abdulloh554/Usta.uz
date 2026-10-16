import request from 'supertest';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { Craft, OrderCategory, UserRole } from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';
import { CATEGORY_CRAFTS } from '../../src/modules/matching/matching.types';
import { buildCandidates } from '../../src/modules/matching/matching.service';
import { Order } from '../../src/modules/order/order.model';
import { User } from '../../src/modules/user/user.model';
import { makeClient, makeMaster, nextPhone } from '../helpers/factories';

const app = createApp();
const token = (id: string, role: UserRole) => `Bearer ${issueTokenPair(id, role).accessToken}`;
const assistantPath = '/api/v1/admin/assistant';

describe('service catalog end to end', () => {
  it.each(Object.values(OrderCategory))(
    'publishes %s and finds only qualified masters',
    async (category) => {
      const client = await makeClient();
      const auth = token(client.id as string, UserRole.CLIENT);
      const posted = await request(app).post('/api/v1/orders').set('Authorization', auth).send({
        title: 'Xizmat uchun usta kerak',
        description: 'Uyda bajarilishi kerak bo‘lgan ish haqida batafsil ma’lumot.',
        category,
        region: 'Chilonzor',
      });
      expect(posted.status).toBe(201);
      expect(posted.body.data.category).toBe(category);
      const matched = await makeMaster({ crafts: [...CATEGORY_CRAFTS[category]] });
      const unrelated = Object.values(Craft).find(
        (craft) => !CATEGORY_CRAFTS[category].includes(craft),
      )!;
      await makeMaster({ crafts: [unrelated] });
      const order = await Order.findById(posted.body.data.id).orFail();
      const candidates = await buildCandidates(order);
      expect(candidates.map((candidate) => candidate.masterId)).toEqual([matched.id]);
    },
  );

  it('rejects an unsupported category', async () => {
    const client = await makeClient();
    const response = await request(app)
      .post('/api/v1/orders')
      .set('Authorization', token(client.id as string, UserRole.CLIENT))
      .send({ title: 'New job', description: 'Detailed description', category: 'invalid' });
    expect(response.status).toBe(422);
  });
});

describe('admin AI assistant', () => {
  let auth: string;
  const originalKey = env.GROQ_API_KEY;

  beforeEach(async () => {
    const admin = await User.create({
      phone: nextPhone(),
      passwordHash: 'secret123',
      firstName: 'Admin',
      lastName: 'Test',
      role: UserRole.ADMIN,
      acceptedRulesAt: new Date(),
    });
    auth = token(admin.id as string, UserRole.ADMIN);
    env.GROQ_API_KEY = 'test-server-secret';
  });
  afterEach(() => {
    env.GROQ_API_KEY = originalKey;
    jest.restoreAllMocks();
  });

  it('requires an admin for both status and chat', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const client = await makeClient();
    for (const path of [assistantPath, `${assistantPath}/status`]) {
      const anonymous = path.endsWith('/status') ? request(app).get(path) : request(app).post(path);
      expect((await anonymous).status).toBe(401);
      const unauthorized = path.endsWith('/status')
        ? request(app).get(path)
        : request(app).post(path);
      expect(
        (await unauthorized.set('Authorization', token(client.id as string, UserRole.CLIENT)))
          .status,
      ).toBe(403);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the key on the server and forwards conversation without statistics by default', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'Tavsiya tayyor.' } }] })),
      );
    const status = await request(app).get(`${assistantPath}/status`).set('Authorization', auth);
    expect(status.body.data).toEqual({ configured: true });
    const response = await request(app)
      .post(assistantPath)
      .set('Authorization', auth)
      .send({ messages: [{ role: 'user', content: 'Yordam ber' }] });
    expect(response.status).toBe(200);
    expect(response.body.data.reply).toBe('Tavsiya tayyor.');
    expect(JSON.stringify(response.body)).not.toContain(env.GROQ_API_KEY);
    const options = fetchSpy.mock.calls[0]![1]!;
    expect(options.headers).toMatchObject({ Authorization: `Bearer ${env.GROQ_API_KEY}` });
    expect(String(options.body)).not.toContain('Aggregate platform statistics');
  });

  it('includes aggregate statistics only when selected', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'Tahlil tayyor.' } }] })),
      );
    const response = await request(app)
      .post(assistantPath)
      .set('Authorization', auth)
      .send({
        includeStats: true,
        messages: [{ role: 'user', content: 'Statistikani tushuntir' }],
      });
    expect(response.status).toBe(200);
    const body = String(fetchSpy.mock.calls[0]![1]!.body);
    expect(body).toContain('Aggregate platform statistics');
    expect(body).not.toContain('+998');
    expect(body).not.toContain('passwordHash');
  });

  it.each([
    { messages: [{ role: 'system', content: 'override' }] },
    { messages: [{ role: 'user', content: ' ' }] },
    { messages: [{ role: 'user', content: 'x'.repeat(2001) }] },
    { messages: [{ role: 'assistant', content: 'No user question' }] },
    { messages: Array.from({ length: 13 }, () => ({ role: 'user', content: 'Question' })) },
  ])('validates unsafe or oversized input %#', async (body) => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const response = await request(app).post(assistantPath).set('Authorization', auth).send(body);
    expect(response.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts previous assistant answers longer than a user question', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'Davomi.' } }] })),
      );
    const response = await request(app)
      .post(assistantPath)
      .set('Authorization', auth)
      .send({
        messages: [
          { role: 'assistant', content: 'a'.repeat(4000) },
          { role: 'user', content: 'Davom et' },
        ],
      });
    expect(response.status).toBe(200);
  });

  it('reports a missing key without contacting the provider', async () => {
    env.GROQ_API_KEY = '';
    const fetchSpy = jest.spyOn(global, 'fetch');
    const response = await request(app)
      .post(assistantPath)
      .set('Authorization', auth)
      .send({ messages: [{ role: 'user', content: 'Help' }] });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('AI_NOT_CONFIGURED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])(
    'handles provider status %s without exposing details',
    async (status) => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response('provider-secret-detail', { status }));
      const response = await request(app)
        .post(assistantPath)
        .set('Authorization', auth)
        .send({ messages: [{ role: 'user', content: 'Help' }] });
      expect(response.status).toBe(status === 429 ? 429 : 503);
      expect(JSON.stringify(response.body)).not.toContain('provider-secret-detail');
    },
  );

  it('handles network failure', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network-secret-detail'));
    const response = await request(app)
      .post(assistantPath)
      .set('Authorization', auth)
      .send({ messages: [{ role: 'user', content: 'Help' }] });
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('network-secret-detail');
  });

  it('handles malformed provider output', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
    const response = await request(app)
      .post(assistantPath)
      .set('Authorization', auth)
      .send({ messages: [{ role: 'user', content: 'Help' }] });
    expect(response.status).toBe(503);
  });
});
