import mongoose from 'mongoose';
import { logger } from '../../config/logger';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/ApiError';
import { NotificationType, OrderStatus, type Paginated } from '../../common/types';
import { paginate } from '../../common/utils/http';
import { Order } from '../order/order.model';
import { MasterProfile } from '../user/masterProfile.model';
import { Product } from '../product/product.model';
import { notify } from '../notification/notification.service';
import { Review, ReviewTarget, type IReview, type ReviewDocument } from './review.model';

/**
 * Recomputes the rating from the reviews themselves rather than folding each new
 * star into a running average. It costs one aggregate per review, and it means a
 * hidden or deleted review — the rules promise bought ratings are removed —
 * corrects the average instead of leaving it permanently skewed.
 */
export const recomputeRating = async (
  targetType: ReviewTarget,
  targetId: mongoose.Types.ObjectId,
): Promise<{ rating: number; ratingCount: number }> => {
  const [summary] = await Review.aggregate<{ average: number; count: number }>([
    { $match: { targetType, target: targetId, isVisible: true } },
    { $group: { _id: null, average: { $avg: '$stars' }, count: { $sum: 1 } } },
  ]);

  const rating = summary ? Math.round(summary.average * 10) / 10 : 0;
  const ratingCount = summary?.count ?? 0;

  if (targetType === ReviewTarget.MASTER) {
    await MasterProfile.updateOne({ user: targetId }, { $set: { rating, ratingCount } });
  } else {
    await Product.updateOne({ _id: targetId }, { $set: { rating, ratingCount } });
  }

  return { rating, ratingCount };
};

export type RateMasterInput = {
  orderId: string;
  stars: number;
  comment?: string;
};

/** The client rates the pro once the job is marked complete. */
export const rateMaster = async (clientId: string, input: RateMasterInput): Promise<ReviewDocument> => {
  const order = await Order.findById(input.orderId);
  if (!order) throw new NotFoundError('Order');

  if (order.client.toString() !== clientId) {
    throw new ForbiddenError('Only the client who posted the job can rate it', 'REVIEW_FORBIDDEN');
  }
  if (order.status !== OrderStatus.DONE) {
    throw new ConflictError('You can rate a job once it is complete', 'ORDER_NOT_COMPLETE');
  }
  if (order.isRated) {
    throw new ConflictError('You have already rated this job', 'ALREADY_RATED');
  }
  if (!order.master) {
    throw new ConflictError('This job has no pro to rate', 'NO_MASTER');
  }

  const review = await Review.create({
    author: new mongoose.Types.ObjectId(clientId),
    targetType: ReviewTarget.MASTER,
    target: order.master,
    order: order._id,
    stars: input.stars,
    comment: input.comment ?? '',
  });

  order.isRated = true;
  await order.save();

  const { rating } = await recomputeRating(ReviewTarget.MASTER, order.master);

  await notify({
    userId: order.master.toString(),
    type: NotificationType.REVIEW_RECEIVED,
    orderId: order.id as string,
    data: { orderId: order.id as string, stars: String(input.stars) },
  }).catch(() => undefined);

  logger.info('Pro rated', { orderId: String(order._id), stars: input.stars, newRating: rating });
  return review;
};

export type RateProductInput = {
  productId: string;
  stars: number;
  comment?: string;
};

/** Both pros and clients review products, as the seller panel shows. */
export const rateProduct = async (
  authorId: string,
  input: RateProductInput,
): Promise<ReviewDocument> => {
  const product = await Product.findById(input.productId);
  if (!product) throw new NotFoundError('Product');

  if (product.seller.toString() === authorId) {
    throw new ForbiddenError('You cannot review your own product', 'SELF_REVIEW');
  }

  const existing = await Review.findOne({
    author: authorId,
    targetType: ReviewTarget.PRODUCT,
    target: product._id,
  });
  if (existing) {
    throw new ConflictError('You have already reviewed this product', 'ALREADY_REVIEWED');
  }

  const review = await Review.create({
    author: new mongoose.Types.ObjectId(authorId),
    targetType: ReviewTarget.PRODUCT,
    target: product._id,
    product: product._id,
    stars: input.stars,
    comment: input.comment ?? '',
  });

  await recomputeRating(ReviewTarget.PRODUCT, product._id);
  return review;
};

const listFor = async (
  targetType: ReviewTarget,
  targetId: string,
  page: number,
  limit: number,
): Promise<Paginated<IReview>> => {
  const filter = {
    targetType,
    target: new mongoose.Types.ObjectId(targetId),
    isVisible: true,
  };
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Review.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('author', 'firstName lastName avatarUrl')
      .lean<IReview[]>(),
    Review.countDocuments(filter),
  ]);

  return paginate(items, total, page, limit);
};

export const listForMaster = (masterId: string, page: number, limit: number): Promise<Paginated<IReview>> =>
  listFor(ReviewTarget.MASTER, masterId, page, limit);

export const listForProduct = (productId: string, page: number, limit: number): Promise<Paginated<IReview>> =>
  listFor(ReviewTarget.PRODUCT, productId, page, limit);

/** Moderation: hiding a bought rating pulls it straight out of the average. */
export const hideReview = async (reviewId: string): Promise<void> => {
  const review = await Review.findByIdAndUpdate(reviewId, { $set: { isVisible: false } }, { new: true });
  if (!review) throw new NotFoundError('Review');
  await recomputeRating(review.targetType, review.target);
};
