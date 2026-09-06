import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../common/middlewares/auth.middleware';
import { validate } from '../../common/middlewares/validate.middleware';
import { ok } from '../../common/utils/http';
import type { AuthenticatedRequest } from '../../common/types';
import { signUpload } from '../../config/cloudinary';

const signSchema = z.object({
  kind: z.enum(['avatar', 'order', 'product']),
});

export const mediaRouter = Router();

/**
 * Hands the client a short-lived, folder-scoped Cloudinary signature so the
 * device uploads straight to Cloudinary. The API never sees the file bytes.
 */
mediaRouter.post(
  '/sign',
  authenticate,
  validate({ body: signSchema }),
  (req, res) => {
    const { kind } = req.body as { kind: 'avatar' | 'order' | 'product' };
    ok(res, signUpload((req as AuthenticatedRequest).user.id, kind));
  },
);
