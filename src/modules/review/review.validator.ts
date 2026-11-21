import { z } from 'zod';
import { objectIdSchema, paginationSchema } from '../../common/middlewares/validate.middleware';

const stars = z.coerce.number().int().min(1, 'Rate from 1 to 5').max(5, 'Rate from 1 to 5');
const comment = z.string().trim().max(1000).optional();

export const rateMasterSchema = z.object({ orderId: objectIdSchema, stars, comment });
export const rateProductSchema = z.object({ productId: objectIdSchema, stars, comment });
export const reviewListQuerySchema = paginationSchema;

export type RateMasterInput = z.infer<typeof rateMasterSchema>;
export type RateProductInput = z.infer<typeof rateProductSchema>;
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;
