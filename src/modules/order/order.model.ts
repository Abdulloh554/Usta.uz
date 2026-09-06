import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';
import { OrderCategory, OrderStatus, UserRole, type Coordinates } from '../../common/types';

/** One entry per pro the matching run has offered this job to. */
export interface IOrderOffer {
  master: Types.ObjectId;
  offeredAt: Date;
  respondedAt?: Date;
  outcome: 'pending' | 'accepted' | 'passed' | 'timeout';
}

export interface IOrder {
  _id: Types.ObjectId;
  /** Human-readable code shown on the job card, e.g. `#A1B2C3`. */
  code: string;
  client: Types.ObjectId;
  master?: Types.ObjectId;
  title: string;
  description: string;
  category: OrderCategory;
  status: OrderStatus;
  address?: string;
  region?: string;
  location?: {
    type: 'Point';
    coordinates: Coordinates;
  };
  photos: string[];
  /** Fee the accepting pro paid, captured at accept time so later price changes do not rewrite history. */
  acceptFee?: number;
  feeTransaction?: Types.ObjectId;
  offers: IOrderOffer[];
  acceptedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  /** Required on cancel by either side, and kept visible on the job. */
  cancelReason?: string;
  cancelledBy?: UserRole;
  isRated: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type OrderDocument = HydratedDocument<IOrder, { id?: string }>;
export type OrderModel = Model<IOrder>;

const offerSchema = new Schema<IOrderOffer>(
  {
    master: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    offeredAt: { type: Date, required: true, default: Date.now },
    respondedAt: { type: Date },
    outcome: {
      type: String,
      enum: ['pending', 'accepted', 'passed', 'timeout'],
      default: 'pending',
    },
  },
  { _id: false },
);

const orderSchema = new Schema<IOrder, OrderModel>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    client: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    master: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    title: { type: String, required: [true, 'Title is required'], trim: true, minlength: 3, maxlength: 120 },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      minlength: 10,
      maxlength: 2000,
    },
    category: { type: String, enum: Object.values(OrderCategory), required: true },
    status: {
      type: String,
      enum: Object.values(OrderStatus),
      default: OrderStatus.PENDING,
      index: true,
    },
    address: { type: String, trim: true, maxlength: 300 },
    region: { type: String, trim: true, index: true },
    location: {
      type: { type: String, enum: ['Point'] },
      coordinates: {
        type: [Number],
        validate: {
          validator: (value: number[]) => value.length === 2,
          message: 'Coordinates must be [longitude, latitude]',
        },
      },
    },
    photos: { type: [String], default: [] },
    acceptFee: { type: Number, min: 0 },
    feeTransaction: { type: Schema.Types.ObjectId, ref: 'Transaction' },
    offers: { type: [offerSchema], default: [] },
    acceptedAt: { type: Date },
    completedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelReason: { type: String, trim: true, maxlength: 300 },
    cancelledBy: { type: String, enum: Object.values(UserRole) },
    isRated: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    ...serializeOptions(),
  },
);

orderSchema.index({ client: 1, status: 1, createdAt: -1 });
orderSchema.index({ master: 1, status: 1, createdAt: -1 });
orderSchema.index({ category: 1, status: 1, createdAt: -1 });
orderSchema.index({ location: '2dsphere' });

/** A cancelled job must carry its reason — the rules screen promises this to both sides. */
orderSchema.pre('validate', function requireCancelReason(next) {
  if (this.status === OrderStatus.CANCELLED && !this.cancelReason) {
    this.invalidate('cancelReason', 'A cancellation reason is required');
  }
  next();
});

export const Order = model<IOrder, OrderModel>('Order', orderSchema);
