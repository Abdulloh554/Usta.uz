import { z } from 'zod';
import { Craft, Language } from '../../common/types';
import { httpsUrl } from '../../common/utils/url';

export const updateProfileSchema = z.object({
  firstName: z.string().trim().min(2).max(50).optional(),
  lastName: z.string().trim().min(2).max(50).optional(),
  language: z.nativeEnum(Language).optional(),
  // `.url()` alone also passes `javascript:` links.
  avatarUrl: httpsUrl().optional(),
});

export const updateMasterSchema = z.object({
  crafts: z
    .array(z.nativeEnum(Craft))
    .min(1)
    .max(12)
    .refine((crafts) => new Set(crafts).size === crafts.length, 'Each trade can be picked once')
    .optional(),
  about: z.string().trim().max(1000).optional(),
  regions: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  location: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
  isAvailable: z.boolean().optional(),
});

export const topMastersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
  craft: z.nativeEnum(Craft).optional(),
});

/**
 * Accounts that sign in with a mailed code have no password, so a code mailed
 * to them is accepted instead.
 */
export const deleteAccountSchema = z
  .object({
    password: z.string().min(1).optional(),
    code: z
      .string()
      .regex(/^\d{6}$/, 'The code is six digits')
      .optional(),
  })
  .refine((body) => body.password || body.code, 'Password or code is required');

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type UpdateMasterInput = z.infer<typeof updateMasterSchema>;
export type TopMastersQuery = z.infer<typeof topMastersSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
