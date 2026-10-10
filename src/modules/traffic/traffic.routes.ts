import { Router } from 'express';
import { validate } from '../../common/middlewares/validate.middleware';
import { asyncHandler, noContent } from '../../common/utils/http';
import { recordVisit, visitSchema, type VisitInput } from './traffic.service';

export const trafficRouter = Router();
trafficRouter.post(
  '/visits',
  validate({ body: visitSchema }),
  asyncHandler(async (req, res) => {
    if (!/bot|crawler|spider|headless/i.test(req.get('user-agent') ?? '')) {
      await recordVisit(req.body as VisitInput);
    }
    noContent(res);
  }),
);
