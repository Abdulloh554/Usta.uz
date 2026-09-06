import { z } from 'zod';
import { Craft, Language, UserRole } from '../../common/types';
import { isValidUzPhone } from '../../common/utils/phone';

const phone = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .refine(isValidUzPhone, 'Enter a valid Uzbek mobile number');

const password = z
  .string()
  .min(6, 'Password must be at least 6 characters')
  .max(128, 'Password is too long');

const name = z.string().trim().min(2, 'Too short').max(50, 'Too long');

export const registerSchema = z
  .object({
    firstName: name,
    lastName: name,
    phone,
    password,
    confirmPassword: password,
    role: z.enum([UserRole.CLIENT, UserRole.MASTER, UserRole.SELLER]),
    language: z.nativeEnum(Language).default(Language.UZ),
    acceptedRules: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the app rules' }),
    }),
    /** Pros only — the trades picked on the sign-up form. */
    crafts: z.array(z.nativeEnum(Craft)).max(12).optional(),
    about: z.string().trim().max(1000).optional(),
    regions: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmPassword'],
        message: 'Passwords do not match',
      });
    }
    if (value.role === UserRole.MASTER && (!value.crafts || value.crafts.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['crafts'],
        message: 'Pick at least one trade',
      });
    }
  });

export const loginSchema = z.object({
  phone,
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const forgotPasswordSchema = z.object({
  phone,
});

export const resetPasswordSchema = z
  .object({
    phone,
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
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
