import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';
import { PaymentProvider, TransactionStatus, TransactionType } from '../../common/types';

export interface ITransaction {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  type: TransactionType;
  status: TransactionStatus;
  provider: PaymentProvider;
  /** Signed amount in so'm: positive credits the wallet, negative debits it. */
  amount: number;
  /** Wallet balance immediately after this transaction settled. */
  balanceAfter?: number;
  order?: Types.ObjectId;
  /** Provider's own transaction id — the idempotency anchor for webhooks. */
  externalId?: string;
  description: string;
  meta: Record<string, unknown>;
  settledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type TransactionDocument = HydratedDocument<ITransaction, { id?: string }>;
export type TransactionModel = Model<ITransaction>;

const transactionSchema = new Schema<ITransaction, TransactionModel>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: Object.values(TransactionType), required: true },
    status: {
      type: String,
      enum: Object.values(TransactionStatus),
      default: TransactionStatus.PENDING,
      index: true,
    },
    provider: { type: String, enum: Object.values(PaymentProvider), required: true },
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: (value: number) => value !== 0,
        message: 'A transaction cannot be for zero',
      },
    },
    balanceAfter: { type: Number },
    order: { type: Schema.Types.ObjectId, ref: 'Order' },
    externalId: { type: String, trim: true },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    meta: { type: Schema.Types.Mixed, default: {} },
    settledAt: { type: Date },
  },
  {
    timestamps: true,
    ...serializeOptions(),
  },
);

transactionSchema.index({ user: 1, createdAt: -1 });
/**
 * Payment providers retry webhooks. Keying on (provider, externalId) makes a
 * replayed callback a duplicate-key error rather than a second credit.
 */
transactionSchema.index(
  { provider: 1, externalId: 1 },
  { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } },
);
/** At most one settled fee per job, so a double-accept cannot double-charge. */
transactionSchema.index(
  { order: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      order: { $exists: true },
      type: TransactionType.ORDER_FEE,
      status: TransactionStatus.SUCCESS,
    },
  },
);

export const Transaction = model<ITransaction, TransactionModel>('Transaction', transactionSchema);
