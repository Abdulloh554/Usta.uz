import { asyncHandler, noContent, ok } from '../../common/utils/http';
import { recordVisit, trafficReport } from './traffic.service';
import type { TrafficQuery, VisitInput } from './traffic.validator';

const BOT_USER_AGENT = /bot|crawler|spider|headless/i;

/** Crawlers are answered like everyone else but never counted. */
export const visit = asyncHandler(async (req, res) => {
  if (!BOT_USER_AGENT.test(req.get('user-agent') ?? '')) {
    await recordVisit(req.body as VisitInput);
  }
  noContent(res);
});

/** Mounted under `/admin/stats/traffic`. */
export const report = asyncHandler(async (req, res) => {
  ok(res, await trafficReport(req.query as unknown as TrafficQuery));
});
