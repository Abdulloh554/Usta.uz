import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { serializeOptions } from '../../common/utils/mongoose';
import { env } from '../../config/env';
import { Language, UserRole } from '../../common/types';

export interface IUser {
  _id: Types.ObjectId;
  phone: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  language: Language;
  avatarUrl?: string;
  /** Balance in so'm. Only pros spend from it, to pay the per-job acceptance fee. */
  balance: number;
  isPhoneVerified: boolean;
  isActive: boolean;
  isBlocked: boolean;
  blockReason?: string;
  /** Set when the person deleted their own account; their details are scrubbed. */
  deletedAt?: Date;
  acceptedRulesAt?: Date;
  pushTokens: string[];
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserMethods {
  comparePassword(candidate: string): Promise<boolean>;
  fullName(): string;
  initials(): string;
}

/** `id` is Mongoose's own virtual; declaring it here keeps it `string` rather than `any`. */
export type UserDocument = HydratedDocument<IUser, IUserMethods & { id?: string }>;
export type UserModel = Model<IUser, Record<string, never>, IUserMethods>;

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      unique: true,
      trim: true,
      // Canonical form only — `normalizePhone` produces it before we ever get here.
      match: [/^\+998\d{9}$/, 'Phone must be stored as +998XXXXXXXXX'],
    },
    passwordHash: {
      type: String,
      required: [true, 'Password is required'],
      select: false,
    },
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    role: {
      type: String,
      enum: Object.values(UserRole),
      required: true,
      default: UserRole.CLIENT,
    },
    language: {
      type: String,
      enum: Object.values(Language),
      default: Language.UZ,
    },
    avatarUrl: { type: String, trim: true },
    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative'],
    },
    isPhoneVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    isBlocked: { type: Boolean, default: false },
    blockReason: { type: String, trim: true, maxlength: 300 },
    deletedAt: { type: Date },
    acceptedRulesAt: { type: Date },
    pushTokens: { type: [String], default: [] },
    lastSeenAt: { type: Date },
  },
  {
    timestamps: true,
    // The hash must never reach a response, even if a route forgets to project it out.
    ...serializeOptions('passwordHash'),
  },
);

userSchema.index({ role: 1, isActive: 1 });
userSchema.index({ createdAt: -1 });

/**
 * Hashing lives on the model rather than in the service, so no code path can
 * write a plaintext password by going around the auth service.
 */
userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('passwordHash')) {
    next();
    return;
  }
  this.passwordHash = await bcrypt.hash(this.passwordHash, env.BCRYPT_ROUNDS);
  next();
});

userSchema.method('comparePassword', function comparePassword(candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.passwordHash);
});

userSchema.method('fullName', function fullName(): string {
  return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.method('initials', function initials(): string {
  return `${this.firstName.charAt(0)}${this.lastName.charAt(0)}`.toUpperCase();
});

export const User = model<IUser, UserModel>('User', userSchema);
