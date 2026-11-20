import request from 'supertest';
import type { Express } from 'express';
import { mailProvider } from '../../src/config/mail';

const PREFIX = '/api/v1';

/**
 * Calls an endpoint that mails a code and returns that code. The mail provider
 * is replaced for the call, so nothing is sent and the six digits can be read
 * back out of the message the server would have mailed.
 */
export const requestCode = async (
  app: Express,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; code: string | null }> => {
  let text = '';
  const spy = jest.spyOn(mailProvider, 'send').mockImplementation(async (message) => {
    text = message.text;
  });
  const response = await request(app).post(`${PREFIX}${path}`).set(headers).send(body);
  spy.mockRestore();

  const match = /(\d{6})/.exec(text);
  return { status: response.status, code: match ? match[1]! : null };
};

/** The whole sign-up: ask for the code, then submit the form with it. */
export const signUp = async (app: Express, form: Record<string, unknown>) => {
  const { code } = await requestCode(app, '/auth/register/request', {
    email: form.email,
    phone: form.phone,
  });
  return request(app)
    .post(`${PREFIX}/auth/register`)
    .send({ ...form, code: code ?? '000000' });
};

/** The whole sign-in: ask for the code, then trade it for a session. */
export const signInWithCode = async (app: Express, email: string) => {
  const { code } = await requestCode(app, '/auth/login/request', { email });
  return request(app)
    .post(`${PREFIX}/auth/login`)
    .send({ email, code: code ?? '000000' });
};
