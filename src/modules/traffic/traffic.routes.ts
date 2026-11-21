import { Router } from 'express';
import { validate } from '../../common/middlewares/validate.middleware';
import * as controller from './traffic.controller';
import { visitSchema } from './traffic.validator';

export const trafficRouter = Router();

trafficRouter.post('/visits', validate({ body: visitSchema }), controller.visit);
