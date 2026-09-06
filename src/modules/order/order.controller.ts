import { asyncHandler, created, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import * as orderService from './order.service';
import * as matchingService from '../matching/matching.service';
import type { CancelOrderInput, CreateOrderInput, ListOrdersInput } from './order.validator';

export const create = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const order = await orderService.createOrder(req.user.id, req.body as CreateOrderInput);
  created(res, order);
});

export const list = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const result = await orderService.listOrdersForUser(
    req.user.id,
    req.user.role,
    req.query as unknown as ListOrdersInput,
  );
  ok(res, result);
});

export const counts = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await orderService.statusCountsForClient(req.user.id));
});

export const detail = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await orderService.getOrderForUser(req.params.id as string, req.user.id));
});

export const feed = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };
  ok(res, await orderService.feedForMaster(req.user.id, page, limit));
});

export const cancel = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const order = await orderService.cancelOrder(
    req.params.id as string,
    req.user.id,
    req.user.role,
    req.body as CancelOrderInput,
  );
  ok(res, order);
});

export const complete = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await orderService.completeOrder(req.params.id as string, req.user.id));
});

/* — the pro's side of matching — */

export const accept = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const result = await matchingService.acceptOffer(req.params.id as string, req.user.id);
  ok(res, { order: result.order, chatId: result.chatId, fee: result.fee });
});

export const pass = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await matchingService.passOffer(req.params.id as string, req.user.id));
});

/** Lets a pro who reconnected pick a still-live offer back up. */
export const outstandingOffer = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await matchingService.outstandingOfferFor(req.user.id));
});
