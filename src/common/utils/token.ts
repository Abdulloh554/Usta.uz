import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env';
import { UnauthorizedError } from '../errors/ApiError';
import type { JwtPayload, UserRole } from '../types';

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  /** The rotation-family id stored in Redis alongside the refresh token. */
  tokenId: string;
};

export const signAccessToken = (userId: string, role: UserRole): string =>
  jwt.sign({ sub: userId, role } satisfies JwtPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  } as SignOptions);

export const signRefreshToken = (userId: string, role: UserRole, tokenId: string): string =>
  jwt.sign({ sub: userId, role, jti: tokenId } satisfies JwtPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
  } as SignOptions);

export const issueTokenPair = (userId: string, role: UserRole): TokenPair => {
  const tokenId = crypto.randomUUID();
  return {
    accessToken: signAccessToken(userId, role),
    refreshToken: signRefreshToken(userId, role, tokenId),
    tokenId,
  };
};

const verify = (token: string, secret: string): JwtPayload => {
  try {
    return jwt.verify(token, secret) as JwtPayload;
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    throw new UnauthorizedError(
      expired ? 'Token has expired' : 'Invalid token',
      expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    );
  }
};

export const verifyAccessToken = (token: string): JwtPayload => verify(token, env.JWT_ACCESS_SECRET);

export const verifyRefreshToken = (token: string): Required<JwtPayload> => {
  const payload = verify(token, env.JWT_REFRESH_SECRET);
  if (!payload.jti) {
    throw new UnauthorizedError('Refresh token is missing its rotation id', 'TOKEN_INVALID');
  }
  return payload as Required<JwtPayload>;
};

/** Seconds until expiry, so Redis entries outlive the token by exactly nothing. */
export const ttlSeconds = (token: string): number => {
  const decoded = jwt.decode(token) as { exp?: number } | null;
  if (!decoded?.exp) return 0;
  return Math.max(0, decoded.exp - Math.floor(Date.now() / 1000));
};

/** Six digits, uniformly distributed — `Math.random` is not acceptable for an auth code. */
export const generateSmsCode = (): string => String(crypto.randomInt(100_000, 1_000_000));

export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');
