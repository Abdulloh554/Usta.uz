import { Craft, OrderCategory } from '../../common/types';

/**
 * Which trades can serve which job category. A client picks one of six
 * categories on the new-job sheet; a pro signs up with one or more of twelve
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
