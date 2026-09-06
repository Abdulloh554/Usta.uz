import { z } from 'zod';
import { OrderCategory, OrderStatus } from '../../common/types';
import { objectIdSchema, paginationSchema } from '../../common/middlewares/validate.middleware';

const coordinates = z
  .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .describe('[longitude, latitude]');

export const createOrderSchema = z.object({
  title: z.string().trim().min(3, 'Title is too short').max(120),
  description: z.string().trim().min(10, 'Describe the problem in a little more detail').max(2000),
  category: z.nativeEnum(OrderCategory),
  address: z.string().trim().max(300).optional(),
  region: z.string().trim().max(60).optional(),
  location: coordinates.optional(),
  photos: z.array(z.string().url()).max(6).default([]),
});

export const listOrdersSchema = paginationSchema.extend({
  status: z.union([z.nativeEnum(OrderStatus), z.literal('all')]).default('all'),
});

export const cancelOrderSchema = z.object({
  // The rules screen promises the reason stays on the job, so it is mandatory.
  reason: z.string().trim().min(3, 'A cancellation reason is required').max(300),
});

export const orderIdParamSchema = z.object({ id: objectIdSchema });

export const feedSchema = paginationSchema;

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;
