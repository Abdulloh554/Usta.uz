import mongoose from 'mongoose';
import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError } from '../../common/errors/ApiError';
import { paginationSchema } from '../../common/middlewares/validate.middleware';
import { normalizePhone, isValidUzPhone } from '../../common/utils/phone';
import { paginate } from '../../common/utils/http';
import { UserRole } from '../../common/types';
import { Product } from './product.model';
import { Purchase, type PurchaseStatus } from './purchase.model';
import { User } from '../user/user.model';

export const purchaseSchema = z.object({
  requestId: z
    .string()
    .min(16)
    .max(100)
    .regex(/^[a-zA-Z0-9-]+$/),
  quantity: z.number().int().min(1).max(1000),
  phone: z.string().refine(isValidUzPhone).transform(normalizePhone),
  address: z.string().trim().min(5).max(300),
});
export const purchaseListSchema = paginationSchema;
export const purchaseStatusSchema = z.object({
  status: z.enum(['accepted', 'completed', 'cancelled']),
});
type Input = z.infer<typeof purchaseSchema>;

export async function createPurchase(buyerId: string, productId: string, input: Input) {
  const previous = await Purchase.findOne({ buyer: buyerId, requestId: input.requestId });
  if (previous) {
    if (
      String(previous.product) !== productId ||
      previous.quantity !== input.quantity ||
      previous.phone !== input.phone ||
      previous.address !== input.address
    ) {
      throw new ConflictError('This request has already been used', 'PURCHASE_REQUEST_CHANGED');
    }
    return previous;
  }
  try {
    return await mongoose.connection.transaction(async (session) => {
      // A retried transaction may run after the same request committed elsewhere.
      const repeated = await Purchase.findOne({
        buyer: buyerId,
        requestId: input.requestId,
      }).session(session);
      if (repeated) {
        if (
          String(repeated.product) !== productId ||
          repeated.quantity !== input.quantity ||
          repeated.phone !== input.phone ||
          repeated.address !== input.address
        ) {
          throw new ConflictError('This request has already been used', 'PURCHASE_REQUEST_CHANGED');
        }
        return repeated;
      }
      const buyer = await User.exists({
        _id: buyerId,
        isActive: true,
        isBlocked: false,
        role: { $in: [UserRole.CLIENT, UserRole.MASTER] },
      }).session(session);
      if (!buyer) throw new ForbiddenError('A shopper account is required');
      const product = await Product.findOneAndUpdate(
        {
          _id: productId,
          isActive: true,
          seller: { $ne: buyerId },
          stock: { $gte: input.quantity },
        },
        { $inc: { stock: -input.quantity } },
        { new: true, session },
      );
      if (!product)
        throw new ConflictError('Product unavailable or insufficient stock', 'PRODUCT_STOCK');
      const seller = await User.exists({
        _id: product.seller,
        role: UserRole.SELLER,
        isActive: true,
        isBlocked: false,
      }).session(session);
      if (!seller) throw new ConflictError('Seller unavailable', 'SELLER_UNAVAILABLE');
      const [purchase] = await Purchase.create(
        [
          {
            buyer: buyerId,
            seller: product.seller,
            product: product._id,
            ...input,
            title: product.title,
            unitPrice: product.price,
            total: product.price * input.quantity,
            status: 'new',
          },
        ],
        { session },
      );
      return purchase!;
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      return createPurchase(buyerId, productId, input);
    throw error;
  }
}

export async function listPurchases(userId: string, role: UserRole, page: number, limit: number) {
  const filter = role === UserRole.SELLER ? { seller: userId } : { buyer: userId };
  const [items, total] = await Promise.all([
    Purchase.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('buyer', 'firstName lastName')
      .populate('seller', 'firstName lastName phone'),
    Purchase.countDocuments(filter),
  ]);
  return paginate(items, total, page, limit);
}

export async function updatePurchase(userId: string, purchaseId: string, status: PurchaseStatus) {
  return mongoose.connection.transaction(async (session) => {
    const purchase = await Purchase.findById(purchaseId).session(session);
    if (!purchase) throw new NotFoundError('Purchase');
    const seller = String(purchase.seller) === userId;
    const buyer = String(purchase.buyer) === userId;
    if (!seller && !buyer) throw new ForbiddenError('This purchase is not yours');
    if (!seller && status !== 'cancelled') throw new ForbiddenError('Seller action required');
    if (purchase.status === status) return purchase;
    if (
      purchase.status === 'cancelled' ||
      purchase.status === 'completed' ||
      (status === 'completed' && purchase.status !== 'accepted') ||
      (status === 'accepted' && purchase.status !== 'new')
    ) {
      throw new ConflictError('Purchase status changed', 'PURCHASE_STATUS');
    }
    purchase.status = status;
    await purchase.save({ session });
    if (status === 'cancelled') {
      await Product.updateOne(
        { _id: purchase.product },
        { $inc: { stock: purchase.quantity } },
        { session },
      );
    } else if (status === 'completed') {
      await Product.updateOne(
        { _id: purchase.product },
        { $inc: { soldCount: purchase.quantity } },
        { session },
      );
    }
    return purchase;
  });
}
