import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';
import { NotificationType } from '../../common/types';

export interface INotification {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  type: NotificationType;
  /** Titles and bodies are stored per language so the push matches the user's app language. */
  title: string;
  body: string;
  data: Record<string, string>;
  order?: Types.ObjectId;
  chat?: Types.ObjectId;
  isRead: boolean;
  readAt?: Date;
  /** A job offer rings the phone until answered — plain notifications do not. */
  isRinging: boolean;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<INotification, { id?: string }>;
export type NotificationModel = Model<INotification>;

const notificationSchema = new Schema<INotification, NotificationModel>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: Object.values(NotificationType), required: true },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body: { type: String, trim: true, maxlength: 500, default: '' },
    data: { type: Schema.Types.Mixed, default: {} },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    chat: { type: Schema.Types.ObjectId, ref: 'Chat' },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
    isRinging: { type: Boolean, default: false },
    sentAt: { type: Date },
  },
  {
    timestamps: true,
    ...serializeOptions(),
  },
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
/** The feed only ever shows recent history; drop anything older than 90 days. */
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const Notification = model<INotification, NotificationModel>('Notification', notificationSchema);
