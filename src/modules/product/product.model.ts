import { Schema, model, type HydratedDocument, type Model, type Types } from 'mongoose';
import { serializeOptions } from '../../common/utils/mongoose';

export interface IProduct {
  _id: Types.ObjectId;
  seller: Types.ObjectId;
  title: string;
  description: string;
  /** Price in so'm — an integer, because so'm has no minor unit in practice. */
  price: number;
  images: string[];
  /** Two-stop gradient the design uses in place of a photo. */
  gradient: { from: string; to: string };
  category?: string;
  stock: number;
  soldCount: number;
  rating: number;
  ratingCount: number;
  isActive: boolean;
  /** Set when the seller deletes it — unlike an admin hide, that cannot be undone by an admin. */
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ProductDocument = HydratedDocument<IProduct, { id?: string }>;
export type ProductModel = Model<IProduct>;

const productSchema = new Schema<IProduct, ProductModel>(
  {
    seller: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: [true, 'Product name is required'], trim: true, minlength: 2, maxlength: 140 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price cannot be negative'],
    },
    images: { type: [String], default: [] },
    gradient: {
      from: { type: String, default: '#8FAE91' },
      to: { type: String, default: '#5F7C63' },
    },
    category: { type: String, trim: true, index: true },
    stock: { type: Number, default: 0, min: 0 },
    soldCount: { type: Number, default: 0, min: 0 },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
    ...serializeOptions(),
  },
);

productSchema.index({ isActive: 1, createdAt: -1 });
productSchema.index({ title: 'text', description: 'text' });

export const Product = model<IProduct, ProductModel>('Product', productSchema);

/** A client's saved-products list — the heart button in the shop grid. */
export interface IFavorite {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  product: Types.ObjectId;
  createdAt: Date;
}

const favoriteSchema = new Schema<IFavorite>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

favoriteSchema.index({ user: 1, product: 1 }, { unique: true });

export const Favorite = model<IFavorite>('Favorite', favoriteSchema);
