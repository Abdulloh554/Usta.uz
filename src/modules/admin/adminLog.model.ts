import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';

/** Every state change an admin can make. The log is append-only. */
export const AdminAction = {
  USER_BLOCKED: 'user.blocked',
  USER_UNBLOCKED: 'user.unblocked',
  USER_ACTIVATED: 'user.activated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_BALANCE_ADJUSTED: 'user.balance_adjusted',
  USER_SESSIONS_REVOKED: 'user.sessions_revoked',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_FEE_REFUNDED: 'order.fee_refunded',
  CHAT_CLOSED: 'chat.closed',
  CHAT_REOPENED: 'chat.reopened',
  MESSAGE_DELETED: 'message.deleted',
  PRODUCT_HIDDEN: 'product.hidden',
  PRODUCT_RESTORED: 'product.restored',
  REVIEW_HIDDEN: 'review.hidden',
  REVIEW_RESTORED: 'review.restored',
  BROADCAST_SENT: 'broadcast.sent',
} as const;
export type AdminAction = (typeof AdminAction)[keyof typeof AdminAction];

export const AdminTarget = {
  USER: 'user',
  ORDER: 'order',
  CHAT: 'chat',
  MESSAGE: 'message',
  PRODUCT: 'product',
  REVIEW: 'review',
  BROADCAST: 'broadcast',
} as const;
export type AdminTarget = (typeof AdminTarget)[keyof typeof AdminTarget];

export interface IAdminLog {
  _id: Types.ObjectId;
  admin: Types.ObjectId;
  action: AdminAction;
  targetType: AdminTarget;
  targetId?: Types.ObjectId;
  /** One human-readable line, so the journal reads without decoding `meta`. */
  summary: string;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export type AdminLogDocument = HydratedDocument<IAdminLog, { id?: string }>;
export type AdminLogModel = Model<IAdminLog>;

const adminLogSchema = new Schema<IAdminLog, AdminLogModel>(
  {
    admin: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, enum: Object.values(AdminAction), required: true },
    targetType: { type: String, enum: Object.values(AdminTarget), required: true },
    targetId: { type: Schema.Types.ObjectId },
    summary: { type: String, trim: true, maxlength: 300, default: '' },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    ...serializeOptions(),
  },
);

adminLogSchema.index({ createdAt: -1 });
adminLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
adminLogSchema.index({ action: 1, createdAt: -1 });

export const AdminLog = model<IAdminLog, AdminLogModel>('AdminLog', adminLogSchema);
