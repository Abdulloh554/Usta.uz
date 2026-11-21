import { asyncHandler, created, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import * as reviewService from './review.service';
import type { RateMasterInput, RateProductInput, ReviewListQuery } from './review.validator';

export const listForMaster = asyncHandler(async (req, res) => {
  const { page, limit } = req.query as unknown as ReviewListQuery;
  ok(res, await reviewService.listForMaster(req.params.id as string, page, limit));
});

export const listForProduct = asyncHandler(async (req, res) => {
  const { page, limit } = req.query as unknown as ReviewListQuery;
  ok(res, await reviewService.listForProduct(req.params.id as string, page, limit));
});

export const rateMaster = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  created(res, await reviewService.rateMaster(req.user.id, req.body as RateMasterInput));
});

export const rateProduct = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  created(res, await reviewService.rateProduct(req.user.id, req.body as RateProductInput));
});

export const hide = asyncHandler(async (req, res) => {
  await reviewService.hideReview(req.params.id as string);
  ok(res, { hidden: true });
});
