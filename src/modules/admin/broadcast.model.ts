import { Schema, model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';

export interface IBroadcast {
  admin: Types.ObjectId;
  audience: 'all' | 'client' | 'master' | 'seller';
  title: string;
  body: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  recipients: number;
  delivered: number;
  lastUser?: Types.ObjectId;
  cutoff: Date;
  leaseOwner?: string;
  leaseUntil: Date;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<IBroadcast>(
  {
    admin: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    audience: { type: String, enum: ['all', 'client', 'master', 'seller'], required: true },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, required: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed'],
      default: 'queued',
    },
    recipients: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    lastUser: { type: Schema.Types.ObjectId },
    cutoff: { type: Date, required: true },
    leaseOwner: { type: String },
    leaseUntil: { type: Date, default: () => new Date(0) },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true, ...serializeOptions('leaseOwner', 'leaseUntil') },
);
schema.index({ status: 1, leaseUntil: 1, createdAt: 1 });
export const Broadcast = model<IBroadcast>('Broadcast', schema);
