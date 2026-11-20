import { redis, keys } from '../../config/redis';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { mailProvider } from '../../config/mail';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../../common/errors/ApiError';
import { formatPhone, normalizePhone, operatorOf } from '../../common/utils/phone';
import { maskEmail, normalizeEmail } from '../../common/utils/email';
import {
  generateSmsCode,
  hashToken,
  issueTokenPair,
  ttlSeconds,
  verifyRefreshToken,
} from '../../common/utils/token';
import { Language, UserRole } from '../../common/types';
import { User, type UserDocument } from '../user/user.model';
import { MasterProfile } from '../user/masterProfile.model';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from './auth.validator';
import type { AuthResult, PhoneCheckResult, PublicUser } from './auth.types';


export const toPublicUser = (user: UserDocument): PublicUser => ({
  id: user.id as string,
  phone: user.phone,
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  fullName: user.fullName(),
  initials: user.initials(),
  role: user.role,
  language: user.language,
  avatarUrl: user.avatarUrl,
  balance: user.balance,
  isPhoneVerified: user.isPhoneVerified,
  acceptedRulesAt: user.acceptedRulesAt,
  createdAt: user.createdAt,
});

/**
 * Refresh tokens are stored in Redis by hash, one entry per rotation-family
 * member. Rotation replaces the entry, so a stolen-and-replayed token finds
 * nothing in the store and is rejected even though its signature is valid.
 */
const storeRefreshToken = async (userId: string, tokenId: string, token: string): Promise<void> => {
  const ttl = ttlSeconds(token);
  if (ttl <= 0) return;
  await redis.set(keys.refreshToken(userId, tokenId), hashToken(token), 'EX', ttl);
};

const revokeRefreshToken = async (userId: string, tokenId: string): Promise<void> => {
  await redis.del(keys.refreshToken(userId, tokenId));
};

const revokeAllRefreshTokens = async (userId: string): Promise<void> => {
  const pattern = keys.refreshTokensOfUser(userId);
  let cursor = '0';
  do {
    // SCAN rather than KEYS: this runs on the request path and must not block Redis.
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (batch.length > 0) await redis.del(...batch);
  } while (cursor !== '0');
};

const issueSession = async (user: UserDocument): Promise<AuthResult> => {
  const { accessToken, refreshToken, tokenId } = issueTokenPair(user.id as string, user.role);
  await storeRefreshToken(user.id as string, tokenId, refreshToken);
  return { user: toPublicUser(user), accessToken, refreshToken };
};

const assertUsable = (user: UserDocument): void => {
  if (user.isBlocked) {
    throw new ForbiddenError(user.blockReason || 'This account is blocked', 'ACCOUNT_BLOCKED');
  }
  if (!user.isActive) {
    throw new ForbiddenError('This account is deactivated', 'ACCOUNT_INACTIVE');
  }
};

/**
 * Sign-up collects the email (the sign-in identity) and the phone number. The
 * number is checked by its operator code only - no SMS - which keeps the cost
 * of a failed sign-up at zero.
 */
export const register = async (input: RegisterInput): Promise<AuthResult> => {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);

  const [phoneTaken, emailTaken] = await Promise.all([
    User.exists({ phone }),
    User.exists({ email }),
  ]);
  if (emailTaken) {
    throw new ConflictError('An account with this email already exists', 'EMAIL_TAKEN');
  }
  if (phoneTaken) {
    throw new ConflictError('An account with this phone number already exists', 'PHONE_TAKEN');
  }

  const user = await User.create({
    phone,
    email,
    passwordHash: input.password,
    firstName: input.firstName,
    lastName: input.lastName,
    role: input.role,
    language: input.language ?? Language.UZ,
    acceptedRulesAt: new Date(),
    isPhoneVerified: false,
    // No sign-up bonus: a pro tops up through a manual request the admin approves.
    balance: 0,
  });

  if (input.role === UserRole.MASTER) {
    await MasterProfile.create({
      user: user._id,
      crafts: input.crafts ?? [],
      about: input.about ?? '',
      regions: input.regions ?? [],
    });
  }

  logger.info('User registered', {
    userId: String(user._id),
    role: user.role,
    email: maskEmail(email),
  });
  return issueSession(user);
};

export const login = async (input: LoginInput): Promise<AuthResult> => {
  // Email is the identity; a phone is honoured only for accounts that have no email yet.
  const filter = input.email
    ? { email: normalizeEmail(input.email) }
    : { phone: normalizePhone(input.phone as string) };

  const user = await User.findOne(filter).select('+passwordHash');
  if (!user) {
    // Same error either way, so the endpoint cannot be used to enumerate accounts.
    throw new UnauthorizedError('Email or password is incorrect', 'INVALID_CREDENTIALS');
  }

  const matches = await user.comparePassword(input.password);
  if (!matches) {
    throw new UnauthorizedError('Email or password is incorrect', 'INVALID_CREDENTIALS');
  }

  assertUsable(user);

  user.lastSeenAt = new Date();
  await user.save();

  return issueSession(user);
};

/** Rotation: the presented token is verified, revoked, and replaced in one step. */
export const refresh = async (token: string): Promise<AuthResult> => {
  const payload = verifyRefreshToken(token);
  const stored = await redis.get(keys.refreshToken(payload.sub, payload.jti));

  if (!stored || stored !== hashToken(token)) {
    // The signature is valid but the token is not the current family member —
    // treat it as a replay and drop every session this user has.
    await revokeAllRefreshTokens(payload.sub);
    throw new UnauthorizedError('Refresh token has been revoked', 'TOKEN_REVOKED');
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new UnauthorizedError('Account no longer exists', 'ACCOUNT_MISSING');
  assertUsable(user);

  await revokeRefreshToken(payload.sub, payload.jti);
  return issueSession(user);
};

export const logout = async (token: string): Promise<void> => {
  try {
    const payload = verifyRefreshToken(token);
    await revokeRefreshToken(payload.sub, payload.jti);
  } catch {
    // Logging out with an already-invalid token is a no-op, not an error.
  }
};

/**
 * Ends every session, including access tokens already handed out: they are
 * refused from the next whole second, and the marker outlives the longest
 * access token it could apply to.
 */
export const logoutEverywhere = async (userId: string): Promise<void> => {
  await revokeAllRefreshTokens(userId);
  await redis.set(keys.revokedBefore(userId), String(Math.ceil(Date.now() / 1000)), 'EX', 24 * 60 * 60);
};

export const checkPhone = async (input: string): Promise<PhoneCheckResult> => {
  const operator = operatorOf(input);
  const digits = input.replace(/\D/g, '').replace(/^998/, '');

  if (operator === null || digits.length !== 9) {
    return { valid: false, operator, registered: false, formatted: formatPhone(input) };
  }

  const phone = normalizePhone(input);
  const existing = await User.exists({ phone });

  return {
    valid: true,
    operator,
    registered: existing !== null,
    formatted: formatPhone(phone),
  };
};

/**
 * Password reset sends the code by email. The code lives for five minutes and
 * survives a fixed number of guesses, both from config.
 */
export const requestPasswordReset = async (input: ForgotPasswordInput): Promise<{ sent: boolean }> => {
  const email = normalizeEmail(input.email);
  const user = await User.findOne({ email });

  // Always report success - a differing response would reveal who is registered.
  if (!user) {
    logger.info('Password reset requested for an unknown email', { email: maskEmail(email) });
    return { sent: true };
  }

  const code = generateSmsCode();
  await redis.set(keys.emailCode(email), hashToken(code), 'EX', env.SMS_CODE_TTL_SECONDS);
  await redis.del(keys.emailAttempts(email));

  const minutes = Math.round(env.SMS_CODE_TTL_SECONDS / 60);
  await mailProvider.send({
    to: email,
    subject: 'USTA.UZ: parolni tiklash kodi',
    text: `Parolni tiklash kodi: ${code}\n\nKod ${minutes} daqiqa amal qiladi. Agar bu so'rovni siz yubormagan bo'lsangiz, xatni e'tiborsiz qoldiring.`,
    html: `<p>Parolni tiklash kodi:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Kod ${minutes} daqiqa amal qiladi. Agar bu so'rovni siz yubormagan bo'lsangiz, xatni e'tiborsiz qoldiring.</p>`,
  });

  logger.info('Password reset code sent', { userId: String(user._id), email: maskEmail(email) });
  return { sent: true };
};

export const resetPassword = async (input: ResetPasswordInput): Promise<{ reset: true }> => {
  const email = normalizeEmail(input.email);

  const attempts = await redis.incr(keys.emailAttempts(email));
  if (attempts === 1) {
    await redis.expire(keys.emailAttempts(email), env.SMS_CODE_TTL_SECONDS);
  }
  if (attempts > env.SMS_CODE_MAX_ATTEMPTS) {
    await redis.del(keys.emailCode(email));
    throw new TooManyRequestsError('Too many wrong codes - request a new one');
  }

  const stored = await redis.get(keys.emailCode(email));
  if (!stored || stored !== hashToken(input.code)) {
    throw new UnauthorizedError('The code is wrong or has expired', 'INVALID_CODE');
  }

  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user) throw new NotFoundError('Account');

  user.passwordHash = input.password;
  await user.save();

  await redis.del(keys.emailCode(email), keys.emailAttempts(email));
  // A password change invalidates every existing session.
  await revokeAllRefreshTokens(user.id as string);

  logger.info('Password reset completed', { userId: String(user._id) });
  return { reset: true };
};

export const me = async (userId: string): Promise<PublicUser> => {
  const user = await User.findById(userId);
  if (!user) throw new NotFoundError('User');
  return toPublicUser(user);
};
