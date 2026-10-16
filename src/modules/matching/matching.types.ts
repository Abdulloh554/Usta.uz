import { Craft, OrderCategory } from '../../common/types';

/**
 * Which trades can serve which job category. A client picks a service from the available
 * categories on the new-job sheet; a pro signs up with one or more supported
 * trades. This table is the join between the two vocabularies.
 */
export const CATEGORY_CRAFTS: Readonly<Record<OrderCategory, readonly Craft[]>> = Object.freeze({
  [OrderCategory.ELECTRICAL]: [Craft.ELECTRICIAN],
  [OrderCategory.PLUMBING]: [Craft.PLUMBER],
  [OrderCategory.RENOVATION]: [
    Craft.PLASTERER,
    Craft.TILER,
    Craft.CARPENTER,
    Craft.PAINTER,
    Craft.DOORS_WINDOWS,
  ],
  [OrderCategory.ELECTRONICS]: [Craft.COMPUTERS, Craft.APPLIANCES, Craft.AC_SERVICE],
  [OrderCategory.CLEANING]: [Craft.CLEANING],
  [OrderCategory.MOVING]: [Craft.MOVING],
  [OrderCategory.PAINTING]: [Craft.PAINTER],
  [OrderCategory.TILING]: [Craft.TILER],
  [OrderCategory.PLASTERING]: [Craft.PLASTERER],
  [OrderCategory.CARPENTRY]: [Craft.CARPENTER],
  [OrderCategory.DOORS_WINDOWS]: [Craft.DOORS_WINDOWS],
  [OrderCategory.AC_SERVICE]: [Craft.AC_SERVICE],
  [OrderCategory.APPLIANCES]: [Craft.APPLIANCES],
  [OrderCategory.COMPUTERS]: [Craft.COMPUTERS],
  [OrderCategory.FURNITURE]: [Craft.CARPENTER],
  [OrderCategory.ROOFING]: [Craft.ROOFER],
  [OrderCategory.WELDING]: [Craft.WELDER],
  [OrderCategory.MASONRY]: [Craft.MASON],
  [OrderCategory.FLOORING]: [Craft.FLOORING],
  [OrderCategory.HEATING]: [Craft.HEATING],
  [OrderCategory.SECURITY]: [Craft.SECURITY],
  [OrderCategory.GARDENING]: [Craft.GARDENER],
  [OrderCategory.PEST_CONTROL]: [Craft.PEST_CONTROL],
  [OrderCategory.AUTO_REPAIR]: [Craft.MECHANIC],
  [OrderCategory.TAILORING]: [Craft.TAILOR],
  [OrderCategory.PHONE_REPAIR]: [Craft.PHONE_REPAIR],
});

export type MatchCandidate = {
  masterId: string;
  rating: number;
  ratingCount: number;
  completedJobs: number;
  distanceKm: number | null;
};

/** What Redis holds for the offer currently outstanding on an order. */
export type OutstandingOffer = {
  orderId: string;
  masterId: string;
  offeredAt: number;
  expiresAt: number;
};

export type MatchingRunState = {
  orderId: string;
  offered: number;
  remaining: number;
  current: string | null;
};
