import { Schema, model } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';

export interface IVisit {
  visitorId: string;
  sessionId: string;
  site: 'web' | 'landing';
  source: 'google' | 'link' | 'direct';
  referrerHost: string;
  path: string;
  campaign: string;
  createdAt: Date;
}

const schema = new Schema<IVisit>(
  {
    visitorId: { type: String, required: true },
    sessionId: { type: String, required: true },
    site: { type: String, enum: ['web', 'landing'], required: true },
    source: { type: String, enum: ['google', 'link', 'direct'], required: true },
    referrerHost: { type: String, default: '' },
    path: { type: String, required: true, maxlength: 500 },
    campaign: { type: String, default: '', maxlength: 150 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, ...serializeOptions() },
);
schema.index({ site: 1, sessionId: 1 }, { unique: true });
schema.index({ createdAt: -1 });
schema.index({ site: 1, source: 1, createdAt: -1 });
schema.index({ source: 1, createdAt: -1 });
schema.index({ site: 1, createdAt: -1 });
export const Visit = model<IVisit>('Visit', schema);
