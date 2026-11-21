import { asyncHandler, created, noContent, ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import * as productService from './product.service';
import * as purchaseService from './purchase.service';
import type {
  ListProductsQuery,
  ProductBodyInput,
  ProductUpdateInput,
  PurchaseInput,
  PurchaseListQuery,
  PurchaseStatusInput,
} from './product.validator';

/* — products — */

export const list = asyncHandler(async (req, res) => {
  const result = await productService.listProducts(req.query as unknown as ListProductsQuery);
  // Signed-in shoppers get their saved set back with the page, so the heart
  // icons render correctly on first paint.
  const favorites = req.user ? await productService.favoriteIds(req.user.id) : [];
  ok(res, { ...result, favorites });
});

export const detail = asyncHandler(async (req, res) => {
  ok(res, await productService.getProduct(req.params.id as string));
});

export const mine = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await productService.listForSeller(req.user.id));
});

export const favorites = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await productService.listFavorites(req.user.id));
});

export const toggleFavorite = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(res, await productService.toggleFavorite(req.user.id, req.params.id as string));
});

export const create = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  created(res, await productService.createProduct(req.user.id, req.body as ProductBodyInput));
});

export const update = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  ok(
    res,
    await productService.updateProduct(
      req.params.id as string,
      req.user.id,
      req.body as ProductUpdateInput,
    ),
  );
});

export const remove = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  await productService.deleteProduct(req.params.id as string, req.user.id);
  noContent(res);
});

/* — purchases — */

export const listPurchases = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { page, limit } = req.query as unknown as PurchaseListQuery;
  ok(res, await purchaseService.listPurchases(req.user.id, req.user.role, page, limit));
});

export const createPurchase = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  created(
    res,
    await purchaseService.createPurchase(
      req.user.id,
      req.params.id as string,
      req.body as PurchaseInput,
    ),
  );
});

export const updatePurchase = asyncHandler<AuthenticatedRequest>(async (req, res) => {
  const { status } = req.body as PurchaseStatusInput;
  ok(res, await purchaseService.updatePurchase(req.user.id, req.params.id as string, status));
});
