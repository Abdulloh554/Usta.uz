import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';
import { Craft, type Coordinates } from '../../common/types';

export interface IMasterProfile {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  crafts: Craft[];
  about: string;
  /** Districts the pro works in, e.g. `['Chilonzor', 'Yunusobod']`. */
  regions: string[];
  location?: {
    type: 'Point';
    coordinates: Coordinates;
  };
  /** Rolling average of review stars, 0 until the first completed job. */
  rating: number;
  ratingCount: number;
  completedJobs: number;
  cancelledJobs: number;
  /** Whether the pro is accepting offers right now — drives the matching candidate list. */
  isOnline: boolean;
  isAvailable: boolean;
  lastOfferAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMasterProfileMethods {
  /** A pro can be offered a job only with the fee's worth of balance available. */
  canAcceptOffers(balance: number, fee: number): boolean;
}

export type MasterProfileDocument = HydratedDocument<
  IMasterProfile,
  IMasterProfileMethods & { id?: string }
>;
export type MasterProfileModel = Model<IMasterProfile, Record<string, never>, IMasterProfileMethods>;

const masterProfileSchema = new Schema<IMasterProfile, MasterProfileModel, IMasterProfileMethods>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    crafts: {
      type: [{ type: String, enum: Object.values(Craft) }],
      required: true,
      validate: {
        validator: (value: Craft[]) => value.length > 0,
        message: 'Pick at least one trade',
      },
    },
    about: { type: String, trim: true, maxlength: 1000, default: '' },
    regions: { type: [String], default: [] },
    location: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number],
        validate: {
          validator: (value: number[]) => value.length === 2,
          message: 'Coordinates must be [longitude, latitude]',
        },
      },
    },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    completedJobs: { type: Number, default: 0, min: 0 },
    cancelledJobs: { type: Number, default: 0, min: 0 },
    isOnline: { type: Boolean, default: false },
    isAvailable: { type: Boolean, default: true },
    lastOfferAt: { type: Date },
  },
  {
    timestamps: true,
    ...serializeOptions(),
  },
);

/**
 * The matching query filters by craft, availability and online state, then sorts
 * by rating descending — this compound index serves that query directly.
 */
masterProfileSchema.index({ crafts: 1, isOnline: 1, isAvailable: 1, rating: -1 });
/**
 * `regions` gets its own index rather than a compound one with `crafts`:
 * MongoDB refuses to index two array fields together ("parallel arrays").
 */
masterProfileSchema.index({ regions: 1 });
masterProfileSchema.index({ location: '2dsphere' });

masterProfileSchema.method(
  'canAcceptOffers',
  function canAcceptOffers(balance: number, fee: number): boolean {
    return this.isOnline && this.isAvailable && balance >= fee;
  },
);

export const MasterProfile = model<IMasterProfile, MasterProfileModel>(
  'MasterProfile',
  masterProfileSchema,
);
