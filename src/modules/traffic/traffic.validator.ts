import { z } from 'zod';
import { paginationSchema } from '../../common/middlewares/validate.middleware';

const httpUrl = z
  .string()
  .max(2000)
  .url()
  .refine((value) => /^https?:\/\//i.test(value));

export const visitSchema = z.object({
  visitorId: z.string().uuid(),
  sessionId: z.string().uuid(),
  site: z.enum(['web', 'landing']),
  url: httpUrl,
  referrer: z.union([httpUrl, z.literal('')]).default(''),
});

export const trafficQuerySchema = paginationSchema.extend({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    })
    .optional(),
  site: z.enum(['web', 'landing']).optional(),
  source: z.enum(['google', 'link', 'direct']).optional(),
});

export type VisitInput = z.infer<typeof visitSchema>;
export type TrafficQuery = z.infer<typeof trafficQuerySchema>;
