import type { RequestHandler } from 'express';
import { keys, redis } from '../../config/redis';
import { logger } from '../../config/logger';
import { ForbiddenError, UnauthorizedError } from '../errors/ApiError';
import { verifyAccessToken } from '../utils/token';
import type { AuthenticatedUser, JwtPayload, UserRole } from '../types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const bearerFrom = (header: string | undefined): string | null => {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
};

/**
 * Access tokens are stateless for their 15 minutes. Blocking an account or
 * signing it out everywhere records a cut-off in Redis, and any token issued
 * before it is refused — otherwise a blocked user keeps working until expiry.
 */
export const isRevoked = async (payload: JwtPayload): Promise<boolean> => {
  if (!payload.iat) return false;
  try {
    const cutoff = await redis.get(keys.revokedBefore(payload.sub));
    return cutoff !== null && payload.iat < Number(cutoff);
  } catch (error) {
    // Fail open: a Redis hiccup must not sign every user out of the app.
    logger.warn('Could not check token revocation', {
      userId: payload.sub,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

/** Rejects the request unless a valid, unrevoked access token is present. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const token = bearerFrom(req.headers.authorization);
  if (!token) {
    next(new UnauthorizedError('Authorization header is missing', 'TOKEN_MISSING'));
    return;
  }

  let payload: JwtPayload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    next(error);
    return;
  }

  void isRevoked(payload).then((revoked) => {
    if (revoked) {
      next(new UnauthorizedError('This session has been ended', 'TOKEN_REVOKED'));
      return;
    }
    req.user = { id: payload.sub, role: payload.role };
    next();
  });
};

/** Attaches `req.user` when a token is present, but never rejects. */
export const optionalAuthenticate: RequestHandler = (req, _res, next) => {
  const token = bearerFrom(req.headers.authorization);
  if (!token) {
    next();
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
  } catch {
    // An invalid token on an optional route is treated as no token at all.
  }
  next();
};

/** Must be mounted after `authenticate`. */
export const authorize =
  (...roles: UserRole[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) {
      next(new UnauthorizedError());
      return;
    }
    if (roles.length > 0 && !roles.includes(req.user.role)) {
      next(new ForbiddenError('Your role cannot perform this action', 'ROLE_FORBIDDEN'));
      return;
    }
    next();
  };
