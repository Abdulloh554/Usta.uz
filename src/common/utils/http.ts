import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Paginated } from '../types';

/** Envelope every successful response shares, so clients parse one shape. */
export type SuccessBody<T> = {
  success: true;
  data: T;
};

export const ok = <T>(res: Response, data: T, status = 200): Response<SuccessBody<T>> =>
  // Express types `json()` as `Response<any>`; the body is built here, so the
  // envelope type is known even though the signature cannot express it.
  res.status(status).json({ success: true, data }) as Response<SuccessBody<T>>;

export const created = <T>(res: Response, data: T): Response<SuccessBody<T>> => ok(res, data, 201);

export const noContent = (res: Response): Response => res.status(204).send();

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 4 does not await handlers, so without this an async throw is silently
 * swallowed and the request hangs.
 */
export const asyncHandler =
  <Req extends Request = Request>(
    handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    void handler(req as unknown as Req, res, next).catch(next);
  };

export const paginate = <T>(items: T[], total: number, page: number, limit: number): Paginated<T> => ({
  items,
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit)),
});
