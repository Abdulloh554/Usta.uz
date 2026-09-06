import type { Request, Response } from 'express';
import { asyncHandler, created, ok } from '../../common/utils/http';
import { UnauthorizedError } from '../../common/errors/ApiError';
import type { AuthenticatedRequest } from '../../common/types';
import * as authService from './auth.service';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from './auth.validator';
import { isProduction } from '../../config/env';

const REFRESH_COOKIE = 'ustauz_rt';

/**
 * The refresh token is set as an httpOnly cookie *and* returned in the body:
 * the web landing page uses the cookie, the mobile app keeps the body value in
 * Expo SecureStore, where no cookie jar exists.
 */
const setRefreshCookie = (res: Response, token: string): void => {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
};

const refreshTokenFrom = (req: Request): string => {
  const body = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
  const cookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  const token = body ?? cookie;
  if (!token) throw new UnauthorizedError('Refresh token is missing', 'TOKEN_MISSING');
  return token;
};

export const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body as RegisterInput);
  setRefreshCookie(res, result.refreshToken);
  created(res, result);
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body as LoginInput);
  setRefreshCookie(res, result.refreshToken);
  ok(res, result);
});

export const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(refreshTokenFrom(req));
  setRefreshCookie(res, result.refreshToken);
  ok(res, result);
});

export const logout = asyncHandler(async (req, res) => {
  const body = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
  const cookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  const token = body ?? cookie;
  if (token) await authService.logout(token);
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  ok(res, { loggedOut: true });
});

export const logoutEverywhere = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  await authService.logoutEverywhere(req.user.id);
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  ok(res, { loggedOut: true });
});

export const checkPhone = asyncHandler(async (req, res) => {
  const { phone } = req.body as { phone: string };
  ok(res, await authService.checkPhone(phone));
});

export const forgotPassword = asyncHandler(async (req, res) => {
  ok(res, await authService.requestPasswordReset(req.body as ForgotPasswordInput));
});

export const resetPassword = asyncHandler(async (req, res) => {
  ok(res, await authService.resetPassword(req.body as ResetPasswordInput));
});

export const me = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await authService.me(req.user.id));
});
