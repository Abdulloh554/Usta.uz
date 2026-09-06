import { Router } from 'express';
import { validate } from '../../common/middlewares/validate.middleware';
import { authenticate } from '../../common/middlewares/auth.middleware';
import { authLimiter, smsLimiter } from '../../common/middlewares/rateLimit.middleware';
import * as controller from './auth.controller';
import {
  checkPhoneSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth.validator';

export const authRouter = Router();

authRouter.post('/check-phone', validate({ body: checkPhoneSchema }), controller.checkPhone);

authRouter.post('/register', authLimiter, validate({ body: registerSchema }), controller.register);
authRouter.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);

// The refresh body is optional — the cookie carries it on web — so the schema is
// applied only when a body is actually present.
authRouter.post(
  '/refresh',
  (req, _res, next) => {
    if (req.body && typeof (req.body as { refreshToken?: unknown }).refreshToken === 'string') {
      validate({ body: refreshSchema })(req, _res, next);
      return;
    }
    next();
  },
  controller.refresh,
);

authRouter.post('/logout', controller.logout);
authRouter.post('/logout-all', authenticate, controller.logoutEverywhere);

authRouter.post(
  '/forgot-password',
  smsLimiter,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);
authRouter.post(
  '/reset-password',
  authLimiter,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);

authRouter.get('/me', authenticate, controller.me);
