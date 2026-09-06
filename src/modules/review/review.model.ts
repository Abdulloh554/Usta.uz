import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';

/** Reviews attach either to a finished job (client rates pro) or to a product. */
export const ReviewTarget = {
  MASTER: 'master',
  PRODUCT: 'product',
} as const;
export type ReviewTarget = (typeof ReviewTarget)[keyof typeof ReviewTarget];

export interface IReview {
  _id: Types.ObjectId;
  author: Types.ObjectId;
  targetType: ReviewTarget;
  /** The rated pro (`User`) or product (`Product`). */
  target: Types.ObjectId;
  order?: Types.ObjectId;
  product?: Types.ObjectId;
  stars: number;
  comment: string;
  isVisible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ReviewDocument = HydratedDocument<IReview, { id?: string }>;
export type ReviewModel = Model<IReview>;

const reviewSchema = new Schema<IReview, ReviewModel>(
  {
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    targetType: { type: String, enum: Object.values(ReviewTarget), required: true },
    target: { type: Schema.Types.ObjectId, required: true, index: true },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    stars: {
      type: Number,
      required: [true, 'A star rating is required'],
      min: [1, 'Rating must be between 1 and 5'],
      max: [5, 'Rating must be between 1 and 5'],
      validate: {
        validator: Number.isInteger,
        message: 'Rating must be a whole number of stars',
      },
    },
    comment: { type: String, trim: true, maxlength: 1000, default: '' },
    isVisible: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    ...serializeOptions(),
  },
);

reviewSchema.index({ targetType: 1, target: 1, createdAt: -1 });
/**
 * One review per finished job. The partial filter keeps product reviews — which
 * carry no `order` — out of the uniqueness constraint.
 */
reviewSchema.index(
  { order: 1, author: 1 },
  { unique: true, partialFilterExpression: { order: { $exists: true } } },
);

export const Review = model<IReview, ReviewModel>('Review', reviewSchema);
