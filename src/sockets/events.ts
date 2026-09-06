import type { OrderStatus } from '../common/types';

/** Every socket event name in one place, so client and server cannot drift. */
export const SocketEvent = {
  /* — connection lifecycle — */
  CONNECTED: 'connected',
  ERROR: 'error',

  /* — matching, pro side — */
  /** A job has been offered to this pro; the app rings until it is answered. */
  ORDER_OFFER: 'order:offer',
  /** The offer is no longer theirs — timed out, or the client cancelled. */
  ORDER_OFFER_REVOKED: 'order:offer:revoked',

  /* — matching, client side — */
  /** Status ticks while the search runs: how many pros have seen it. */
  ORDER_SEARCHING: 'order:searching',
  ORDER_ACCEPTED: 'order:accepted',
  ORDER_NO_MASTERS: 'order:no_masters',
  ORDER_STATUS: 'order:status',
  ORDER_COMPLETED: 'order:completed',
  ORDER_CANCELLED: 'order:cancelled',

  /* — chat — */
  CHAT_JOIN: 'chat:join',
  CHAT_LEAVE: 'chat:leave',
  CHAT_MESSAGE: 'chat:message',
  CHAT_MESSAGE_NEW: 'chat:message:new',
  CHAT_TYPING: 'chat:typing',
  CHAT_TYPING_STATE: 'chat:typing:state',
  CHAT_READ: 'chat:read',
  CHAT_READ_STATE: 'chat:read:state',

  /* — presence — */
  PRESENCE_ONLINE: 'presence:online',
  PRESENCE_STATE: 'presence:state',

  /* — notifications — */
  NOTIFICATION: 'notification',
} as const;
export type SocketEvent = (typeof SocketEvent)[keyof typeof SocketEvent];

export type OrderOfferPayload = {
  orderId: string;
  code: string;
  title: string;
  description: string;
  category: string;
  client: { id: string; name: string; initials: string };
  distanceKm: number | null;
  region: string | null;
  fee: number;
  /** Seconds the pro has to answer before the job moves to the next one. */
  expiresInSeconds: number;
  expiresAt: string;
};

export type OrderSearchingPayload = {
  orderId: string;
  status: OrderStatus;
  /** How many pros have been offered the job so far. */
  offered: number;
  /** How many candidates are still queued behind the current offer. */
  remaining: number;
};

export type OrderAcceptedPayload = {
  orderId: string;
  chatId: string;
  master: {
    id: string;
    name: string;
    initials: string;
    rating: number;
    crafts: string[];
  };
};

export type ChatMessagePayload = {
  chatId: string;
  messageId: string;
  senderId: string;
  text: string;
  kind: string;
  createdAt: string;
};

export type TypingPayload = {
  chatId: string;
  userId: string;
  isTyping: boolean;
};

/** Room naming. A user room reaches every device that user is signed in on. */
export const room = {
  user: (userId: string): string => `user:${userId}`,
  chat: (chatId: string): string => `chat:${chatId}`,
  order: (orderId: string): string => `order:${orderId}`,
} as const;
