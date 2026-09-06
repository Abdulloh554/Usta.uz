import mongoose from 'mongoose';
import { ForbiddenError, NotFoundError } from '../../common/errors/ApiError';
import { NotificationType, type Paginated } from '../../common/types';
import { paginate } from '../../common/utils/http';
import { emitToChat, emitToUser } from '../../sockets/emitter';
import { SocketEvent } from '../../sockets/events';
import { notify } from '../notification/notification.service';
import { Chat, Message, MessageKind, type ChatDocument, type IMessage } from './chat.model';

/**
 * `participants` may hold raw ids or populated user documents depending on the
 * query, and a populated document does not stringify to its id — comparing it
 * directly would lock a genuine participant out of their own conversation.
 */
const idOf = (value: unknown): string => {
  if (value && typeof value === 'object' && '_id' in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
};

const assertParticipant = (chat: ChatDocument, userId: string): void => {
  const isParticipant = chat.participants.some((participant) => idOf(participant) === userId);
  if (!isParticipant) throw new ForbiddenError('This conversation is not yours', 'CHAT_FORBIDDEN');
};

export const listChats = async (userId: string): Promise<ChatDocument[]> =>
  Chat.find({ participants: userId })
    .sort({ lastMessageAt: -1, createdAt: -1 })
    .populate('participants', 'firstName lastName avatarUrl lastSeenAt')
    .populate('order', 'code title status')
    .populate('lastMessage', 'text kind sender createdAt')
    .exec();

export const getChat = async (chatId: string, userId: string): Promise<ChatDocument> => {
  const chat = await Chat.findById(chatId)
    .populate('participants', 'firstName lastName avatarUrl lastSeenAt')
    .populate('order', 'code title status');

  if (!chat) throw new NotFoundError('Chat');
  assertParticipant(chat, userId);
  return chat;
};

export const getChatByOrder = async (orderId: string, userId: string): Promise<ChatDocument> => {
  const chat = await Chat.findOne({ order: orderId })
    .populate('participants', 'firstName lastName avatarUrl lastSeenAt')
    .populate('order', 'code title status');

  if (!chat) throw new NotFoundError('Chat');
  assertParticipant(chat, userId);
  return chat;
};

/**
 * Newest-first, so an infinite list can page backwards from the bottom the way
 * a chat view scrolls. The client reverses each page for display.
 */
export const listMessages = async (
  chatId: string,
  userId: string,
  page: number,
  limit: number,
): Promise<Paginated<IMessage>> => {
  const chat = await Chat.findById(chatId);
  if (!chat) throw new NotFoundError('Chat');
  assertParticipant(chat, userId);

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    Message.find({ chat: chatId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean<IMessage[]>(),
    Message.countDocuments({ chat: chatId }),
  ]);

  return paginate(items, total, page, limit);
};

export type SendMessageInput = {
  text?: string;
  kind?: MessageKind;
  attachmentUrl?: string;
};

export const sendMessage = async (
  chatId: string,
  senderId: string,
  input: SendMessageInput,
): Promise<IMessage> => {
  const chat = await Chat.findById(chatId);
  if (!chat) throw new NotFoundError('Chat');
  assertParticipant(chat, senderId);

  const message = await Message.create({
    chat: chat._id,
    sender: new mongoose.Types.ObjectId(senderId),
    kind: input.kind ?? MessageKind.TEXT,
    text: input.text ?? '',
    attachmentUrl: input.attachmentUrl,
    // The sender has necessarily read their own message.
    readBy: [new mongoose.Types.ObjectId(senderId)],
  });

  const recipient = chat.participants.find((participant) => participant.toString() !== senderId);

  chat.lastMessage = message._id;
  chat.lastMessageAt = message.createdAt;
  if (recipient) {
    const key = recipient.toString();
    chat.unread.set(key, (chat.unread.get(key) ?? 0) + 1);
  }
  await chat.save();

  const payload = {
    chatId,
    messageId: (message._id).toString(),
    senderId,
    text: message.text,
    kind: message.kind,
    createdAt: message.createdAt.toISOString(),
  };

  emitToChat(chatId, SocketEvent.CHAT_MESSAGE_NEW, payload);

  if (recipient) {
    // Also to the user room: the recipient may have the app open elsewhere, or
    // be closed entirely and reachable only by push.
    emitToUser(recipient.toString(), SocketEvent.CHAT_MESSAGE_NEW, payload);
    await notify({
      userId: recipient.toString(),
      type: NotificationType.NEW_MESSAGE,
      chatId,
      body: message.kind === MessageKind.TEXT ? message.text.slice(0, 120) : undefined,
      data: { chatId },
    }).catch(() => undefined);
  }

  return message.toObject();
};

export const markRead = async (chatId: string, userId: string): Promise<void> => {
  const chat = await Chat.findById(chatId);
  if (!chat) throw new NotFoundError('Chat');
  assertParticipant(chat, userId);

  await Message.updateMany(
    { chat: chatId, readBy: { $ne: userId } },
    { $addToSet: { readBy: new mongoose.Types.ObjectId(userId) } },
  );

  chat.unread.set(userId, 0);
  await chat.save();

  emitToChat(chatId, SocketEvent.CHAT_READ_STATE, { chatId, userId });
};

export const unreadTotal = async (userId: string): Promise<number> => {
  const chats = await Chat.find({ participants: userId }).select('unread').lean();
  return chats.reduce((total, chat) => {
    const unread = chat.unread as unknown as Record<string, number> | Map<string, number>;
    const count = unread instanceof Map ? unread.get(userId) : unread?.[userId];
    return total + (count ?? 0);
  }, 0);
};

/** Used by the socket layer before joining a room, so rooms cannot be guessed. */
export const canAccessChat = async (chatId: string, userId: string): Promise<boolean> => {
  const chat = await Chat.findById(chatId).select('participants').lean();
  return chat?.participants.some((participant) => participant.toString() === userId) ?? false;
};
