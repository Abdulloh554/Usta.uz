import { z } from 'zod';
import { Craft, Language, UserRole } from '../../common/types';
import { isValidUzPhone } from '../../common/utils/phone';

const phone = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .refine(isValidUzPhone, 'Enter a valid Uzbek mobile number');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Email is required')
  .max(254, 'Email is too long')
  .email('Enter a valid email address');

const password = z
  .string()
  .min(6, 'Password must be at least 6 characters')
  .max(128, 'Password is too long');

const name = z.string().trim().min(2, 'Too short').max(50, 'Too long');

const code = z.string().trim().regex(/^\d{6}$/, 'The code is six digits');

/** Step one of sign-up: the address the code goes to, and the number to keep unique. */
export const registerRequestSchema = z.object({ email, phone });

/** Step two: the whole form plus the code that was emailed. No password anywhere. */
export const registerSchema = z
  .object({
    firstName: name,
    lastName: name,
    email,
    phone,
    code,
    role: z.enum([UserRole.CLIENT, UserRole.MASTER, UserRole.SELLER]),
    language: z.nativeEnum(Language).default(Language.UZ),
    acceptedRules: z.literal(true, { error: 'You must accept the app rules' }),
    /** Pros only - the trades picked on the sign-up form. */
    crafts: z
      .array(z.nativeEnum(Craft))
      .max(12)
      .refine((crafts) => new Set(crafts).size === crafts.length, 'Each trade can be picked once')
      .optional(),
    about: z.string().trim().max(1000).optional(),
    regions: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.role === UserRole.MASTER && (!value.crafts || value.crafts.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['crafts'],
        message: 'Pick at least one trade',
      });
    }
  });

/** Sends the sign-in code. Always answers the same, whether or not the account exists. */
export const loginRequestSchema = z.object({ email });

/**
 * Sign-in is by email and the code mailed to it. A password is still accepted
 * for accounts that have one (admins, and people who signed up before codes),
 * and `phone` for accounts that have no email yet.
 */
export const loginSchema = z
  .object({
    email: email.optional(),
    phone: phone.optional(),
    password: z.string().min(1, 'Password is required').optional(),
    code: code.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.email && !value.phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'Email is required' });
    }
    if (value.code && !value.email) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['email'], message: 'Email is required' });
    }
    if (!value.code && !value.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: 'The code is required' });
    }
  });

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const forgotPasswordSchema = z.object({
  email,
});

export const resetPasswordSchema = z
  .object({
    email,
    code: z.string().regex(/^\d{6}$/, 'The code is six digits'),
    password,
    confirmPassword: password,
  })
  .superRefine((value, ctx) => {
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Passwords do not match',
      });
    }
  });

export const checkPhoneSchema = z.object({
  phone: z.string().trim().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type RegisterRequestInput = z.infer<typeof registerRequestSchema>;
export type LoginRequestInput = z.infer<typeof loginRequestSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
