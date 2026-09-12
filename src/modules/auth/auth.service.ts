import { redis, keys } from '../../config/redis';
import { env, paymentsEnabled } from '../../config/env';
import { logger } from '../../config/logger';
import { smsProvider } from '../../config/sms';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../../common/errors/ApiError';
import { formatPhone, maskPhone, normalizePhone, operatorOf } from '../../common/utils/phone';
import {
  generateSmsCode,
  hashToken,
  issueTokenPair,
  ttlSeconds,
  verifyRefreshToken,
} from '../../common/utils/token';
import {
  Language,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../../common/types';
import { User, type UserDocument } from '../user/user.model';
import { MasterProfile } from '../user/masterProfile.model';
import { Transaction } from '../wallet/transaction.model';
import type {
  ForgotPasswordInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
} from './auth.validator';
import type { AuthResult, PhoneCheckResult, PublicUser } from './auth.types';

const MASTER_SIGNUP_BONUS = 100_000;

export const toPublicUser = (user: UserDocument): PublicUser => ({
  id: user.id as string,
  phone: user.phone,
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
 * Sign-up validates the number by its operator code only — no SMS. That is what
 * the design promises on the registration screen, and it keeps the cost of a
 * failed sign-up at zero.
 */
export const register = async (input: RegisterInput): Promise<AuthResult> => {
  const phone = normalizePhone(input.phone);

  const existing = await User.findOne({ phone }).lean();
  if (existing) {
    throw new ConflictError('An account with this phone number already exists', 'PHONE_TAKEN');
  }

  const user = await User.create({
    phone,
    passwordHash: input.password,
    firstName: input.firstName,
    lastName: input.lastName,
    role: input.role,
    language: input.language ?? Language.UZ,
    acceptedRulesAt: new Date(),
    isPhoneVerified: false,
    // Sign-up bonus so a new pro can accept their first jobs before topping up.
    // With payments off, accepting is free and a balance would mean nothing.
    balance: input.role === UserRole.MASTER && paymentsEnabled() ? MASTER_SIGNUP_BONUS : 0,
  });

  // Every so'm in a wallet has a ledger entry, the bonus included — otherwise the
  // pro's history and the admin's totals cannot explain the balance.
  if (user.balance > 0) {
    await Transaction.create({
      user: user._id,
      type: TransactionType.ADJUSTMENT,
      status: TransactionStatus.SUCCESS,
      provider: PaymentProvider.BALANCE,
      amount: user.balance,
      balanceAfter: user.balance,
      description: 'Sign-up bonus',
      settledAt: new Date(),
    });
  }

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
    phone: maskPhone(phone),
  });
  return issueSession(user);
};

export const login = async (input: LoginInput): Promise<AuthResult> => {
  const phone = normalizePhone(input.phone);

  const user = await User.findOne({ phone }).select('+passwordHash');
  if (!user) {
    // Same error either way, so the endpoint cannot be used to enumerate numbers.
    throw new UnauthorizedError('Phone number or password is incorrect', 'INVALID_CREDENTIALS');
  }

  const matches = await user.comparePassword(input.password);
  if (!matches) {
    throw new UnauthorizedError('Phone number or password is incorrect', 'INVALID_CREDENTIALS');
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
 * Password reset is the one flow that sends an SMS. The code lives for five
 * minutes and survives a fixed number of guesses, both from config.
 */
export const requestPasswordReset = async (input: ForgotPasswordInput): Promise<{ sent: boolean }> => {
  const phone = normalizePhone(input.phone);
  const user = await User.findOne({ phone });

  // Always report success — a differing response would reveal who is registered.
  if (!user) {
    logger.info('Password reset requested for an unknown number', { phone: maskPhone(phone) });
    return { sent: true };
  }

  const code = generateSmsCode();
  await redis.set(keys.smsCode(phone), hashToken(code), 'EX', env.SMS_CODE_TTL_SECONDS);
  await redis.del(keys.smsAttempts(phone));

  const minutes = Math.round(env.SMS_CODE_TTL_SECONDS / 60);
  await smsProvider.send(
    phone,
    `USTA.UZ: parolni tiklash kodi ${code}. Kod ${minutes} daqiqa amal qiladi.`,
  );

  logger.info('Password reset code sent', { userId: String(user._id), phone: maskPhone(phone) });
  return { sent: true };
};

export const resetPassword = async (input: ResetPasswordInput): Promise<{ reset: true }> => {
  const phone = normalizePhone(input.phone);

  const attempts = await redis.incr(keys.smsAttempts(phone));
  if (attempts === 1) {
    await redis.expire(keys.smsAttempts(phone), env.SMS_CODE_TTL_SECONDS);
  }
  if (attempts > env.SMS_CODE_MAX_ATTEMPTS) {
    await redis.del(keys.smsCode(phone));
    throw new TooManyRequestsError('Too many wrong codes — request a new one');
  }

  const stored = await redis.get(keys.smsCode(phone));
  if (!stored || stored !== hashToken(input.code)) {
    throw new UnauthorizedError('The code is wrong or has expired', 'INVALID_CODE');
  }

  const user = await User.findOne({ phone }).select('+passwordHash');
  if (!user) throw new NotFoundError('Account');

  user.passwordHash = input.password;
  user.isPhoneVerified = true;
  await user.save();

  await redis.del(keys.smsCode(phone), keys.smsAttempts(phone));
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
