import type { Language, UserRole } from '../../common/types';

export type PublicUser = {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  fullName: string;
  initials: string;
  role: UserRole;
  language: Language;
  avatarUrl?: string;
  balance: number;
  isPhoneVerified: boolean;
  acceptedRulesAt?: Date;
  createdAt: Date;
};

export type AuthResult = {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
};

export type PhoneCheckResult = {
  /** `true` once the operator prefix resolves to a known Uzbek network. */
  valid: boolean;
  operator: string | null;
  /** Whether an account already exists — the sign-up form uses this to steer to login. */
  registered: boolean;
  formatted: string;
};
