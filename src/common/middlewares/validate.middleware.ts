import type { RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';

export type RequestSchema = {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
};

/**
 * Parses and *replaces* the request parts with their validated output, so a
 * controller reading `req.body` gets the coerced, typed value rather than the
 * raw payload. A failure throws a `ZodError`, which the error middleware turns
 * into a 422 with per-field details.
 */
export const validate =
  (schema: RequestSchema): RequestHandler =>
  (req, _res, next) => {
    try {
      if (schema.params) req.params = schema.params.parse(req.params) as typeof req.params;
      if (schema.query) {
        // `req.query` has only a getter in Express 5-style setups; assign in place.
        Object.defineProperty(req, 'query', {
          value: schema.query.parse(req.query),
          writable: true,
          configurable: true,
        });
      }
      if (schema.body) req.body = schema.body.parse(req.body) as unknown;
      next();
    } catch (error) {
      next(error);
    }
  };

/** Reusable primitives the module validators build on. */
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const idParamSchema = z.object({ id: objectIdSchema });
