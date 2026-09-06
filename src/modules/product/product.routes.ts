import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, optionalAuthenticate } from '../../common/middlewares/auth.middleware';
import {
  idParamSchema,
  paginationSchema,
  validate,
} from '../../common/middlewares/validate.middleware';
import { asyncHandler, created, noContent, ok } from '../../common/utils/http';
import { UserRole, type AuthenticatedRequest } from '../../common/types';
import * as productService from './product.service';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour');

const productBodySchema = z.object({
  title: z.string().trim().min(2).max(140),
  description: z.string().trim().max(2000).optional(),
  price: z.coerce.number().int().nonnegative(),
  images: z.array(z.string().url()).max(8).optional(),
  category: z.string().trim().max(60).optional(),
  stock: z.coerce.number().int().nonnegative().optional(),
  gradient: z.object({ from: hexColor, to: hexColor }).optional(),
});

const listQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  seller: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

export const productRouter = Router();

/* — seller-owned routes, before `/:id` so they are not read as ids — */
productRouter.get(
  '/mine',
  authenticate,
  authorize(UserRole.SELLER),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    ok(res, await productService.listForSeller(req.user.id));
  }),
);

productRouter.get(
  '/favorites',
  authenticate,
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    ok(res, await productService.listFavorites(req.user.id));
  }),
);

productRouter.get(
  '/',
  optionalAuthenticate,
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as {
      page: number;
      limit: number;
      search?: string;
      category?: string;
      seller?: string;
    };
    const result = await productService.listProducts(query);
    // Signed-in shoppers get their saved set back with the page, so the heart
    // icons render correctly on first paint.
    const favorites = req.user ? await productService.favoriteIds(req.user.id) : [];
    ok(res, { ...result, favorites });
  }),
);

productRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    ok(res, await productService.getProduct(req.params.id as string));
  }),
);

productRouter.post(
  '/',
  authenticate,
  authorize(UserRole.SELLER),
  validate({ body: productBodySchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const product = await productService.createProduct(
      req.user.id,
      req.body as productService.CreateProductInput,
    );
    created(res, product);
  }),
);

productRouter.patch(
  '/:id',
  authenticate,
  authorize(UserRole.SELLER),
  validate({ params: idParamSchema, body: productBodySchema.partial() }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    const product = await productService.updateProduct(
      req.params.id as string,
      req.user.id,
      req.body as Partial<productService.CreateProductInput>,
    );
    ok(res, product);
  }),
);

productRouter.delete(
  '/:id',
  authenticate,
  authorize(UserRole.SELLER),
  validate({ params: idParamSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    await productService.deleteProduct(req.params.id as string, req.user.id);
    noContent(res);
  }),
);

productRouter.post(
  '/:id/favorite',
  authenticate,
  validate({ params: idParamSchema }),
  asyncHandler<AuthenticatedRequest>(async (req, res) => {
    ok(res, await productService.toggleFavorite(req.user.id, req.params.id as string));
  }),
);
