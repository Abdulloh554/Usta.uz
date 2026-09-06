import type { SchemaOptions } from 'mongoose';

/**
 * Mongoose types the `transform` callback's `ret` with every schema field
 * required, so `delete ret.__v` is a type error at each call site. Deleting
 * through a widened alias keeps that noise in one place instead of scattering
 * casts across every model.
 */
const strip = (ret: unknown, fields: string[]): Record<string, unknown> => {
  const record = ret as Record<string, unknown>;
  fields.forEach((field) => {
    delete record[field];
  });
  return record;
};

/** Serialisation defaults every model shares: expose `id`, hide `__v`. */
export const serializeOptions = (...hidden: string[]): Pick<SchemaOptions, 'toJSON' | 'toObject'> => ({
  toJSON: {
    virtuals: true,
    transform: (_doc, ret) => strip(ret, ['__v', ...hidden]),
  },
  toObject: { virtuals: true },
});
