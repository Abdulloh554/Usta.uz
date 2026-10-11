import { z } from 'zod';
import type { PipelineStage } from 'mongoose';
import { env, isTest } from '../../config/env';
import { cached, invalidate } from '../../common/utils/cache';
import { paginationSchema } from '../../common/middlewares/validate.middleware';
import { Visit, type IVisit } from './traffic.model';

const httpUrl = z
  .string()
  .max(2000)
  .url()
  .refine((value) => /^https?:\/\//i.test(value));
export const visitSchema = z.object({
  visitorId: z.string().uuid(),
  sessionId: z.string().uuid(),
  site: z.enum(['web', 'landing']),
  url: httpUrl,
  referrer: z.union([httpUrl, z.literal('')]).default(''),
});

export const trafficQuerySchema = paginationSchema.extend({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    })
    .optional(),
  site: z.enum(['web', 'landing']).optional(),
  source: z.enum(['google', 'link', 'direct']).optional(),
});
export type VisitInput = z.infer<typeof visitSchema>;
export type TrafficQuery = z.infer<typeof trafficQuerySchema>;
type Count = { visits: number; visitors: number };
type TrafficFacet = {
  totals: Count[];
  sources: Array<Count & { _id: IVisit['source'] }>;
  hours: Array<Count & { _id: { hour: number; source: IVisit['source'] } }>;
  hourlyVisitors: Array<{ _id: number; visitors: number }>;
};
const statsKey = (date: string, site?: string, source?: string) =>
  `traffic:counts:v2:${date}:${site ?? 'all'}:${source ?? 'all'}`;

// Accept Google's actual search domains, never a substring like google.com.evil.test.
export const isGoogleHost = (host: string): boolean =>
  /^(?:www\.)?google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(host);

export async function recordVisit(input: VisitInput) {
  const url = new URL(input.url);
  const referrer = input.referrer ? new URL(input.referrer) : null;
  const external = referrer && referrer.hostname !== url.hostname;
  const utmSource = (url.searchParams.get('utm_source') ?? '').toLowerCase();
  let source: IVisit['source'] = 'direct';
  if (external || utmSource || url.searchParams.has('utm_campaign')) source = 'link';
  if (
    isGoogleHost(utmSource) ||
    utmSource === 'google' ||
    url.searchParams.has('gclid') ||
    (external && isGoogleHost(referrer.hostname))
  )
    source = 'google';
  try {
    const result = await Visit.updateOne(
      { site: input.site, sessionId: input.sessionId },
      {
        $setOnInsert: {
          visitorId: input.visitorId,
          source,
          referrerHost: external ? referrer.hostname : '',
          path: url.pathname.slice(0, 500),
          campaign: (url.searchParams.get('utm_campaign') ?? '').slice(0, 150),
        },
      },
      { upsert: true, timestamps: { createdAt: true, updatedAt: false } },
    );
    if (result.upsertedCount > 0) {
      const date = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
      await invalidate(
        statsKey(date),
        statsKey(date, input.site),
        statsKey(date, undefined, source),
        statsKey(date, input.site, source),
      );
    }
  } catch (error) {
    // Concurrent retries of the same session are still a single visit.
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}

export async function trafficReport(query: TrafficQuery) {
  const date = query.date ?? new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00+05:00`);
  const end = new Date(start.getTime() + 24 * 3600_000);
  const match = {
    createdAt: { $gte: start, $lt: end },
    ...(query.site ? { site: query.site } : {}),
    ...(query.source ? { source: query.source } : {}),
  };
  // Two-stage grouping counts unique browsers without building one enormous
  // $addToSet array/BSON document. Independent groups may spill to disk.
  const hourExpression = { $hour: { date: '$createdAt', timezone: 'Asia/Tashkent' } };
  const aggregate = <T>(stages: PipelineStage[]) =>
    Visit.aggregate<T>([{ $match: match }, ...stages])
      .allowDiskUse(true)
      .option({ maxTimeMS: 15_000 });
  const [data, items] = await Promise.all([
    cached(
      statsKey(date, query.site, query.source),
      isTest ? 0 : env.STATS_CACHE_SECONDS,
      async (): Promise<TrafficFacet> => {
        const [totals, sources, hours, hourlyVisitors] = await Promise.all([
          aggregate<Count>([
            { $group: { _id: '$visitorId', visits: { $sum: 1 } } },
            { $group: { _id: null, visits: { $sum: '$visits' }, visitors: { $sum: 1 } } },
            { $project: { _id: 0, visits: 1, visitors: 1 } },
          ]),
          aggregate<TrafficFacet['sources'][number]>([
            { $group: { _id: { source: '$source', visitor: '$visitorId' }, visits: { $sum: 1 } } },
            { $group: { _id: '$_id.source', visits: { $sum: '$visits' }, visitors: { $sum: 1 } } },
          ]),
          aggregate<TrafficFacet['hours'][number]>([
            {
              $group: {
                _id: { hour: hourExpression, source: '$source', visitor: '$visitorId' },
                visits: { $sum: 1 },
              },
            },
            {
              $group: {
                _id: { hour: '$_id.hour', source: '$_id.source' },
                visits: { $sum: '$visits' },
                visitors: { $sum: 1 },
              },
            },
          ]),
          aggregate<TrafficFacet['hourlyVisitors'][number]>([
            { $group: { _id: { hour: hourExpression, visitor: '$visitorId' } } },
            { $group: { _id: '$_id.hour', visitors: { $sum: 1 } } },
          ]),
        ]);
        return { totals, sources, hours, hourlyVisitors };
      },
    ),
    Visit.find(match)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
  ]);
  const total = data.totals[0]?.visits ?? 0;
  const sources = ['google', 'link', 'direct'].map((source) => ({
    source,
    visits: 0,
    visitors: 0,
    ...data.sources.find((row: { _id: string }) => row._id === source),
  }));
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    visitors: data.hourlyVisitors.find((row: { _id: number }) => row._id === hour)?.visitors ?? 0,
    visits: data.hours
      .filter((row: { _id: { hour: number } }) => row._id.hour === hour)
      .reduce((sum: number, row: { visits: number }) => sum + row.visits, 0),
    ...Object.fromEntries(
      ['google', 'link', 'direct'].map((source) => [
        source,
        data.hours.find(
          (row: { _id: { hour: number; source: string } }) =>
            row._id.hour === hour && row._id.source === source,
        )?.visitors ?? 0,
      ]),
    ),
  }));
  return {
    date,
    timezone: 'Asia/Tashkent',
    totals: data.totals[0] ?? { visits: 0, visitors: 0 },
    sources,
    hours,
    entries: {
      items,
      total,
      page: query.page,
      limit: query.limit,
      pages: Math.ceil(total / query.limit),
    },
  };
}
