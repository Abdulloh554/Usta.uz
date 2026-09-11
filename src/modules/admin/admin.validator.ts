import { z } from 'zod';
import { objectIdSchema, paginationSchema } from '../../common/middlewares/validate.middleware';
import {
  OrderCategory,
  OrderStatus,
  PaymentProvider,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../../common/types';
import { AdminAction } from './adminLog.model';
import { ReviewTarget } from '../review/review.model';

const search = z.string().trim().max(120).optional();

/** `?flag=true` arrives as a string; `z.coerce.boolean()` would read `"false"` as true. */
const booleanish = z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]);

export const timeseriesSchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
});

export const listUsersSchema = paginationSchema.extend({
  search,
  role: z.nativeEnum(UserRole).optional(),
  status: z.enum(['all', 'active', 'blocked', 'inactive']).default('all'),
  sort: z.enum(['new', 'old', 'balance', 'seen']).default('new'),
});

export const updateUserStatusSchema = z
  .object({
    isBlocked: z.boolean().optional(),
    blockReason: z.string().trim().max(300).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.isBlocked !== undefined || value.isActive !== undefined, {
    message: 'Nothing to change',
  });

export const adjustBalanceSchema = z.object({
  /** Signed so'm: positive credits the wallet, negative debits it. */
  amount: z
    .number()
    .int()
    .refine((value) => value !== 0, 'Amount cannot be zero')
    .refine((value) => Math.abs(value) <= 100_000_000, 'Amount is too large'),
  note: z.string().trim().min(3).max(300),
});

export const listOrdersSchema = paginationSchema.extend({
  search,
  status: z.nativeEnum(OrderStatus).optional(),
  category: z.nativeEnum(OrderCategory).optional(),
  user: objectIdSchema.optional(),
});

export const adminCancelOrderSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  refundFee: z.boolean().default(false),
});

export const listChatsSchema = paginationSchema.extend({
  search,
  user: objectIdSchema.optional(),
  status: z.enum(['all', 'open', 'closed']).default('all'),
});

export const messagesSchema = paginationSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const updateChatSchema = z.object({ isClosed: z.boolean() });

export const listProductsSchema = paginationSchema.extend({
  search,
  status: z.enum(['all', 'active', 'hidden']).default('all'),
  seller: objectIdSchema.optional(),
});

export const updateProductSchema = z.object({ isActive: z.boolean() });

export const listReviewsSchema = paginationSchema.extend({
  targetType: z.nativeEnum(ReviewTarget).optional(),
  visible: booleanish.optional(),
  stars: z.coerce.number().int().min(1).max(5).optional(),
  author: objectIdSchema.optional(),
});

export const updateReviewSchema = z.object({ isVisible: z.boolean() });

export const listTransactionsSchema = paginationSchema.extend({
  type: z.nativeEnum(TransactionType).optional(),
  status: z.nativeEnum(TransactionStatus).optional(),
  provider: z.nativeEnum(PaymentProvider).optional(),
  user: objectIdSchema.optional(),
});

export const broadcastSchema = z.object({
  audience: z.enum(['all', UserRole.CLIENT, UserRole.MASTER, UserRole.SELLER]),
  title: z.string().trim().min(2).max(140),
  body: z.string().trim().min(2).max(500),
});

export const listLogsSchema = paginationSchema.extend({
  action: z.nativeEnum(AdminAction).optional(),
  admin: objectIdSchema.optional(),
});

export type ListUsersInput = z.infer<typeof listUsersSchema>;
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>;
export type AdjustBalanceInput = z.infer<typeof adjustBalanceSchema>;
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;
export type AdminCancelOrderInput = z.infer<typeof adminCancelOrderSchema>;
export type ListChatsInput = z.infer<typeof listChatsSchema>;
export type ListProductsInput = z.infer<typeof listProductsSchema>;
export type ListReviewsInput = z.infer<typeof listReviewsSchema>;
export type ListTransactionsInput = z.infer<typeof listTransactionsSchema>;
export type BroadcastInput = z.infer<typeof broadcastSchema>;
export type ListLogsInput = z.infer<typeof listLogsSchema>;
