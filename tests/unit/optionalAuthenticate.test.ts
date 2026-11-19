import type { NextFunction, Request, Response } from 'express';
import { optionalAuthenticate } from '../../src/common/middlewares/auth.middleware';
import { keys, redis } from '../../src/config/redis';
import { UserRole } from '../../src/common/types';
import { issueTokenPair } from '../../src/common/utils/token';

const USER_ID = '507f1f77bcf86cd799439011';

const run = (authorization?: string): Promise<Request> =>
  new Promise((resolve) => {
    const req = { headers: authorization ? { authorization } : {} } as Request;
    const next: NextFunction = () => resolve(req);
    optionalAuthenticate(req, {} as Response, next);
  });

describe('optionalAuthenticate', () => {
  it('attaches the user for a valid token', async () => {
    const req = await run(`Bearer ${issueTokenPair(USER_ID, UserRole.CLIENT).accessToken}`);
    expect(req.user).toEqual({ id: USER_ID, role: UserRole.CLIENT });
  });

  it('carries on anonymously without a token or with a garbage one', async () => {
    expect((await run()).user).toBeUndefined();
    expect((await run('Bearer not-a-jwt')).user).toBeUndefined();
  });

  it('ignores a token issued before the account was signed out everywhere', async () => {
    const token = issueTokenPair(USER_ID, UserRole.CLIENT).accessToken;
    await redis.set(keys.revokedBefore(USER_ID), String(Math.floor(Date.now() / 1000) + 60));

    const req = await run(`Bearer ${token}`);
    expect(req.user).toBeUndefined();
  });
});
