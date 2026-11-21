import { z } from 'zod';
import { paginationSchema } from '../../common/middlewares/validate.middleware';
import { decodeWebPushToken, isWebPushToken } from '../../config/push';

export const notificationListQuerySchema = paginationSchema;

/**
 * A phone's FCM token, or a browser's push subscription as `webpush:…` (see
 * `config/push`). A browser subscription is checked here, at the door: one
 * that does not decode to a known push service is refused, never stored.
 */
export const deviceSchema = z.object({
  token: z
    .string()
    .trim()
    .min(10)
    .max(2000)
    .refine(
      (token) => !isWebPushToken(token) || decodeWebPushToken(token) !== null,
      'Not a valid push subscription',
    )
    .refine((token) => isWebPushToken(token) || token.length <= 500, 'Device token is too long'),
});

export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
export type DeviceInput = z.infer<typeof deviceSchema>;
