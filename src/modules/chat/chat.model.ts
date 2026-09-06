import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';

export interface IChat {
  _id: Types.ObjectId;
  /** Exactly the two people on a job: the client and the pro who accepted it. */
  participants: Types.ObjectId[];
  order: Types.ObjectId;
  lastMessage?: Types.ObjectId;
  lastMessageAt?: Date;
  /** Unread counts keyed by user id, so a badge needs no aggregation. */
  unread: Map<string, number>;
  isClosed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ChatDocument = HydratedDocument<IChat, { id?: string }>;
export type ChatModel = Model<IChat>;

const chatSchema = new Schema<IChat, ChatModel>(
  {
    participants: {
      type: [{ type: Schema.Types.ObjectId, ref: 'User' }],
      required: true,
      validate: {
        validator: (value: Types.ObjectId[]) => value.length === 2,
        message: 'A chat has exactly two participants',
      },
    },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    lastMessage: { type: Schema.Types.ObjectId, ref: 'Message' },
    lastMessageAt: { type: Date },
    unread: { type: Map, of: Number, default: () => new Map<string, number>() },
    isClosed: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    ...serializeOptions(),
  },
);

chatSchema.index({ participants: 1, lastMessageAt: -1 });

export const Chat = model<IChat, ChatModel>('Chat', chatSchema);

export const MessageKind = {
  TEXT: 'text',
  IMAGE: 'image',
  SYSTEM: 'system',
} as const;
export type MessageKind = (typeof MessageKind)[keyof typeof MessageKind];

export interface IMessage {
  _id: Types.ObjectId;
  chat: Types.ObjectId;
  sender: Types.ObjectId;
  kind: MessageKind;
  text: string;
  attachmentUrl?: string;
  readBy: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    chat: { type: Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: Object.values(MessageKind), default: MessageKind.TEXT },
    text: { type: String, trim: true, maxlength: 4000, default: '' },
    attachmentUrl: { type: String, trim: true },
    readBy: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [] },
  },
  {
    timestamps: true,
    ...serializeOptions(),
  },
);

messageSchema.index({ chat: 1, createdAt: -1 });

/** A text message with no body is never useful; an image message may have none. */
messageSchema.pre('validate', function requireContent(next) {
  if (this.kind === MessageKind.TEXT && this.text.trim().length === 0) {
    this.invalidate('text', 'Message text cannot be empty');
  }
  if (this.kind === MessageKind.IMAGE && !this.attachmentUrl) {
    this.invalidate('attachmentUrl', 'An image message needs an attachment');
  }
  next();
});

export const Message = model<IMessage>('Message', messageSchema);
