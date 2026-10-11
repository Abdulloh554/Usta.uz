import { Schema, model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';

export type PurchaseStatus = 'new' | 'accepted' | 'completed' | 'cancelled';
export interface IPurchase {
  buyer: Types.ObjectId;
  seller: Types.ObjectId;
  product: Types.ObjectId;
  requestId: string;
  title: string;
  unitPrice: number;
  quantity: number;
  total: number;
  phone: string;
  address: string;
  status: PurchaseStatus;
  createdAt: Date;
}
const schema = new Schema<IPurchase>(
  {
    buyer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    requestId: { type: String, required: true },
    title: { type: String, required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    total: { type: Number, required: true, min: 0 },
    phone: { type: String, required: true },
    address: { type: String, required: true, maxlength: 300 },
    status: { type: String, enum: ['new', 'accepted', 'completed', 'cancelled'], default: 'new' },
  },
  { timestamps: true, ...serializeOptions() },
);
schema.index({ buyer: 1, requestId: 1 }, { unique: true });
schema.index({ buyer: 1, createdAt: -1 });
schema.index({ seller: 1, createdAt: -1 });
export const Purchase = model<IPurchase>('Purchase', schema);
