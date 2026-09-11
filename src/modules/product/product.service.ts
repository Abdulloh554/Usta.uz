import mongoose, { type FilterQuery } from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../common/errors/ApiError';
import type { Paginated } from '../../common/types';
import { paginate } from '../../common/utils/http';
import { Favorite, Product, type IProduct, type ProductDocument } from './product.model';

export type CreateProductInput = {
  title: string;
  description?: string;
  price: number;
  images?: string[];
  category?: string;
  stock?: number;
  gradient?: { from: string; to: string };
};

export const createProduct = (sellerId: string, input: CreateProductInput): Promise<ProductDocument> =>
  Product.create({
    seller: new mongoose.Types.ObjectId(sellerId),
    title: input.title,
    description: input.description ?? '',
    price: input.price,
    images: input.images ?? [],
    category: input.category,
    stock: input.stock ?? 0,
    ...(input.gradient ? { gradient: input.gradient } : {}),
  });

export const updateProduct = async (
  productId: string,
  sellerId: string,
  input: Partial<CreateProductInput>,
): Promise<ProductDocument> => {
  const product = await Product.findById(productId);
  // A removed product is gone as far as its seller is concerned, too.
  if (!product || !product.isActive) throw new NotFoundError('Product');
  if (product.seller.toString() !== sellerId) {
    throw new ForbiddenError('This product is not yours', 'PRODUCT_FORBIDDEN');
  }

  Object.assign(product, input);
  await product.save();
  return product;
};

export const deleteProduct = async (productId: string, sellerId: string): Promise<void> => {
  const product = await Product.findById(productId);
  if (!product || !product.isActive) throw new NotFoundError('Product');
  if (product.seller.toString() !== sellerId) {
    throw new ForbiddenError('This product is not yours', 'PRODUCT_FORBIDDEN');
  }
  // Soft delete: existing orders and reviews still reference it.
  product.isActive = false;
  product.deletedAt = new Date();
  await product.save();
};

const withId = <T extends { _id: mongoose.Types.ObjectId }>(rows: T[]): Array<T & { id: string }> =>
  rows.map((row) => ({ ...row, id: String(row._id) }));

export type ListProductsInput = {
  page: number;
  limit: number;
  search?: string;
  category?: string;
  seller?: string;
};

export const listProducts = async (input: ListProductsInput): Promise<Paginated<IProduct>> => {
  const filter: FilterQuery<IProduct> = { isActive: true };
  if (input.category) filter.category = input.category;
  if (input.seller) filter.seller = new mongoose.Types.ObjectId(input.seller);
  if (input.search) filter.$text = { $search: input.search };

  const skip = (input.page - 1) * input.limit;

  const [items, total] = await Promise.all([
    Product.find(filter)
      .sort(input.search ? { score: { $meta: 'textScore' } } : { createdAt: -1 })
      .skip(skip)
      .limit(input.limit)
      .populate('seller', 'firstName lastName avatarUrl')
      .lean<IProduct[]>(),
    Product.countDocuments(filter),
  ]);

  // `.lean()` skips the `id` virtual every hydrated document carries, and the
  // app keys products by `id` — so it is added back here.
  return paginate(withId(items), total, input.page, input.limit);
};

export const getProduct = async (productId: string): Promise<ProductDocument> => {
  const product = await Product.findById(productId).populate('seller', 'firstName lastName avatarUrl');
  if (!product || !product.isActive) throw new NotFoundError('Product');
  return product;
};

export const listForSeller = (sellerId: string): Promise<ProductDocument[]> =>
  Product.find({ seller: sellerId, isActive: true }).sort({ createdAt: -1 }).exec();

/** The heart button. Returns the new state so the client can render optimistically. */
export const toggleFavorite = async (
  userId: string,
  productId: string,
): Promise<{ favorited: boolean }> => {
  // Un-saving always works, even for a product the seller has since removed.
  const existing = await Favorite.findOneAndDelete({ user: userId, product: productId });
  if (existing) return { favorited: false };

  const available = await Product.exists({ _id: productId, isActive: true });
  if (!available) throw new NotFoundError('Product');

  try {
    await Favorite.create({
      user: new mongoose.Types.ObjectId(userId),
      product: new mongoose.Types.ObjectId(productId),
    });
  } catch (error) {
    // A double tap races two creates; the unique index keeps one, and the
    // loser's answer is the same: it is saved.
    if ((error as { code?: number }).code !== 11000) throw error;
  }
  return { favorited: true };
};

export const listFavorites = async (userId: string): Promise<IProduct[]> => {
  const favorites = await Favorite.find({ user: userId })
    .sort({ createdAt: -1 })
    .populate<{ product: IProduct }>({
      path: 'product',
      populate: { path: 'seller', select: 'firstName lastName avatarUrl' },
    })
    .lean();

  return withId(favorites.map((favorite) => favorite.product).filter((product) => product?.isActive));
};

/** Only products still on sale — a removed one must not light a heart or count as saved. */
export const favoriteIds = async (userId: string): Promise<string[]> => {
  const favorites = await Favorite.find({ user: userId })
    .populate<{ product: Pick<IProduct, '_id' | 'isActive'> | null }>({ path: 'product', select: 'isActive' })
    .lean();
  return favorites
    .filter((favorite) => favorite.product?.isActive)
    .map((favorite) => String(favorite.product!._id));
};
