import { z } from 'zod';
import { paginationSchema } from '../../common/middlewares/validate.middleware';
import { PaymentProvider } from '../../common/types';
import { MAX_TOP_UP, MIN_TOP_UP } from './wallet.service';

export const transactionsQuerySchema = paginationSchema;

export const topUpSchema = z.object({
  amount: z.coerce.number().int().positive(),
  provider: z.enum([PaymentProvider.PAYME, PaymentProvider.CLICK]),
});

/** A manual top-up request: what the pro says they transferred, and from where. */
export const topUpRequestSchema = z.object({
  amount: z.coerce.number().int().min(MIN_TOP_UP).max(MAX_TOP_UP),
  payerNote: z.string().trim().min(3).max(200),
});

export type TransactionsQuery = z.infer<typeof transactionsQuerySchema>;
export type TopUpInput = z.infer<typeof topUpSchema>;
export type TopUpRequestInput = z.infer<typeof topUpRequestSchema>;
