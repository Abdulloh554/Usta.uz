import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors/ApiError';
import { verifyAccessToken } from '../utils/token';
import type { AuthenticatedUser, UserRole } from '../types';

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

/** Rejects the request unless a valid access token is present. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const token = bearerFrom(req.headers.authorization);
  if (!token) {
    next(new UnauthorizedError('Authorization header is missing', 'TOKEN_MISSING'));
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (error) {
    next(error);
  }
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
