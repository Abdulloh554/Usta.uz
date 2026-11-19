import { z } from 'zod';

/**
 * A user-supplied link that will be rendered (as an `<img src>`, a chat
 * attachment, an avatar). `z.string().url()` alone accepts `javascript:`,
 * `data:` and plain `http:` links; only `https://` is let through. Uploads go
 * straight to Cloudinary, whose `secure_url` is always https.
 */
export const httpsUrl = () =>
  z
    .string()
    .trim()
    .max(2048)
    .url()
    .refine((value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    }, 'Must be an https:// link');
