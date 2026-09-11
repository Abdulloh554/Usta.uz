import type { Request } from 'express';
import type { Types } from 'mongoose';

export const UserRole = {
  CLIENT: 'client',
  MASTER: 'master',
  SELLER: 'seller',
  ADMIN: 'admin',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

export const Language = {
  UZ: 'uz',
  RU: 'ru',
  EN: 'en',
} as const;
export type Language = (typeof Language)[keyof typeof Language];

/** Mirrors `ST` in the design prototype — the four states a job card can show. */
export const OrderStatus = {
  PENDING: 'pending',
  MATCHING: 'matching',
  ACCEPTED: 'accepted',
  DONE: 'done',
  CANCELLED: 'cancelled',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const TransactionType = {
  TOP_UP: 'top_up',
  ORDER_FEE: 'order_fee',
  REFUND: 'refund',
  PAYOUT: 'payout',
  /** A manual correction made from the admin panel, signed like any other amount. */
  ADJUSTMENT: 'adjustment',
} as const;
export type TransactionType = (typeof TransactionType)[keyof typeof TransactionType];

export const TransactionStatus = {
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED: 'failed',
  REVERSED: 'reversed',
} as const;
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

export const PaymentProvider = {
  PAYME: 'payme',
  CLICK: 'click',
  BALANCE: 'balance',
} as const;
export type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];

/** The providers a user can actually top up with — `balance` is internal-only. */
export type TopUpProvider = typeof PaymentProvider.PAYME | typeof PaymentProvider.CLICK;

export const NotificationType = {
  ORDER_OFFER: 'order_offer',
  ORDER_ACCEPTED: 'order_accepted',
  ORDER_CANCELLED: 'order_cancelled',
  ORDER_COMPLETED: 'order_completed',
  NEW_MESSAGE: 'new_message',
  REVIEW_RECEIVED: 'review_received',
  WALLET_TOPPED_UP: 'wallet_topped_up',
  /** A message the team broadcasts from the admin panel. */
  ANNOUNCEMENT: 'announcement',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/** The 12 trades the design's craft picker offers. */
export const Craft = {
  ELECTRICIAN: 'electrician',
  PLUMBER: 'plumber',
  PLASTERER: 'plasterer',
  TILER: 'tiler',
  CARPENTER: 'carpenter',
  PAINTER: 'painter',
  AC_SERVICE: 'ac_service',
  COMPUTERS: 'computers',
  APPLIANCES: 'appliances',
  DOORS_WINDOWS: 'doors_windows',
  MOVING: 'moving',
  CLEANING: 'cleaning',
} as const;
export type Craft = (typeof Craft)[keyof typeof Craft];

/** The 6 job categories the design's "quick pick" grid and new-job sheet offer. */
export const OrderCategory = {
  ELECTRICAL: 'electrical',
  PLUMBING: 'plumbing',
  RENOVATION: 'renovation',
  ELECTRONICS: 'electronics',
  CLEANING: 'cleaning',
  MOVING: 'moving',
} as const;
export type OrderCategory = (typeof OrderCategory)[keyof typeof OrderCategory];

export type JwtPayload = {
  sub: string;
  role: UserRole;
  /** Present on refresh tokens only; identifies the rotation family member. */
  jti?: string;
};

export type AuthenticatedUser = {
  id: string;
  role: UserRole;
};

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

export type ObjectId = Types.ObjectId;

export type Paginated<T> = {
  items: T[];
  page: number;
  limit: number;
  total: number;
  pages: number;
};

/** A `[longitude, latitude]` pair, in the order GeoJSON demands. */
export type Coordinates = [number, number];
