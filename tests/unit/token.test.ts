import jwt from 'jsonwebtoken';
import {
  generateSmsCode,
  hashToken,
  issueTokenPair,
  signAccessToken,
  ttlSeconds,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../src/common/utils/token';
import { UnauthorizedError } from '../../src/common/errors/ApiError';
import { UserRole } from '../../src/common/types';
import { env } from '../../src/config/env';

describe('token utilities', () => {
  const userId = '507f1f77bcf86cd799439011';

  it('round-trips an access token', () => {
    const token = signAccessToken(userId, UserRole.MASTER);
    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe(userId);
    expect(payload.role).toBe(UserRole.MASTER);
  });

  it('issues a pair whose refresh token carries the rotation id', () => {
    const pair = issueTokenPair(userId, UserRole.CLIENT);
    const payload = verifyRefreshToken(pair.refreshToken);
    expect(payload.jti).toBe(pair.tokenId);
    expect(pair.accessToken).not.toBe(pair.refreshToken);
  });

  it('gives each pair a distinct rotation id', () => {
    const first = issueTokenPair(userId, UserRole.CLIENT);
    const second = issueTokenPair(userId, UserRole.CLIENT);
    expect(first.tokenId).not.toBe(second.tokenId);
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign({ sub: userId, role: UserRole.ADMIN }, 'a-different-secret-entirely');
    expect(() => verifyAccessToken(forged)).toThrow(UnauthorizedError);
  });

  it('reports an expired token distinctly from an invalid one', () => {
    const expired = jwt.sign({ sub: userId, role: UserRole.CLIENT }, env.JWT_ACCESS_SECRET, {
      expiresIn: '-1s',
    });
    try {
      verifyAccessToken(expired);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as UnauthorizedError).code).toBe('TOKEN_EXPIRED');
    }
  });

  it('refuses a refresh token with no rotation id', () => {
    const noJti = jwt.sign({ sub: userId, role: UserRole.CLIENT }, env.JWT_REFRESH_SECRET, {
      expiresIn: '1d',
    });
    expect(() => verifyRefreshToken(noJti)).toThrow(UnauthorizedError);
  });

  it('will not verify a refresh token as an access token', () => {
    const pair = issueTokenPair(userId, UserRole.CLIENT);
    expect(() => verifyAccessToken(pair.refreshToken)).toThrow(UnauthorizedError);
  });

  it('reports a positive TTL for a fresh token and zero for a token with no exp', () => {
    const token = signAccessToken(userId, UserRole.CLIENT);
    expect(ttlSeconds(token)).toBeGreaterThan(0);
    expect(ttlSeconds(jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET))).toBe(0);
  });

  describe('generateSmsCode', () => {
    it('always produces six digits', () => {
      for (let i = 0; i < 200; i += 1) {
        expect(generateSmsCode()).toMatch(/^\d{6}$/);
      }
    });

    it('does not repeat itself trivially', () => {
      const codes = new Set(Array.from({ length: 50 }, () => generateSmsCode()));
      expect(codes.size).toBeGreaterThan(40);
    });
  });

  it('hashes deterministically, and differently per input', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
    expect(hashToken('abc')).toHaveLength(64);
  });
});
