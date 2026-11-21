import { z } from 'zod';
import { paginationSchema } from '../../common/middlewares/validate.middleware';
import { isValidUzPhone, normalizePhone } from '../../common/utils/phone';
import { httpsUrl } from '../../common/utils/url';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour');

/**
 * Accepts `12000` or `"12000"` from a form, but not the values `z.coerce` would
 * quietly turn into a number — `""` and `null` became 0, `true` became 1.
 */
const wholeNumber = (max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number().int().nonnegative().max(max),
  );

/* — products — */

export const productBodySchema = z.object({
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().max(2000).optional(),
  price: wholeNumber(1_000_000_000),
  // `z.string().url()` also passes `javascript:` links, which must never reach an `<img>`.
  images: z.array(httpsUrl()).max(8).optional(),
  category: z.string().trim().max(60).optional(),
  stock: wholeNumber(1_000_000).optional(),
  gradient: z.object({ from: hexColor, to: hexColor }).optional(),
});

export const productUpdateSchema = productBodySchema.partial();

export const listProductsSchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  seller: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .optional(),
});

/* — purchases — */

export const purchaseSchema = z.object({
  requestId: z
    .string()
    .min(16)
    .max(100)
    .regex(/^[a-zA-Z0-9-]+$/),
  quantity: z.number().int().min(1).max(1000),
  phone: z.string().refine(isValidUzPhone).transform(normalizePhone),
  address: z.string().trim().min(5).max(300),
});

export const purchaseListSchema = paginationSchema;

export const purchaseStatusSchema = z.object({
  status: z.enum(['accepted', 'completed', 'cancelled']),
});

export type ProductBodyInput = z.infer<typeof productBodySchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
export type ListProductsQuery = z.infer<typeof listProductsSchema>;
export type PurchaseInput = z.infer<typeof purchaseSchema>;
export type PurchaseListQuery = z.infer<typeof purchaseListSchema>;
export type PurchaseStatusInput = z.infer<typeof purchaseStatusSchema>;
