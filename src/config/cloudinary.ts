import crypto from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { env } from './env';
import { logger } from './logger';
import { ServiceUnavailableError } from '../common/errors/ApiError';

const isConfigured =
  Boolean(env.CLOUDINARY_CLOUD_NAME) &&
  Boolean(env.CLOUDINARY_API_KEY) &&
  Boolean(env.CLOUDINARY_API_SECRET);

if (isConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  logger.warn('Cloudinary is not configured — media uploads will be rejected');
}

export type UploadSignature = {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  folder: string;
  /** Where the client PUTs the file. */
  uploadUrl: string;
};

/**
 * Issues a signed upload ticket instead of proxying the file.
 *
 * The alternative — accepting multipart uploads on this server and forwarding
 * them — doubles the bandwidth bill and ties up a Node process for the length of
 * a phone's slow upload. Signing lets the device talk to Cloudinary directly
 * while the API still controls which folder it may write to and for how long the
 * permission lasts.
 */
export const signUpload = (userId: string, kind: 'avatar' | 'order' | 'product'): UploadSignature => {
  if (!isConfigured) {
    throw new ServiceUnavailableError('Media uploads are not available', 'MEDIA_UNCONFIGURED');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = `ustauz/${kind}/${userId}`;

  // Cloudinary signs the alphabetically-sorted parameter string plus the secret.
  const params = `folder=${folder}&timestamp=${timestamp}`;
  const signature = crypto
    .createHash('sha1')
    .update(`${params}${env.CLOUDINARY_API_SECRET}`)
    .digest('hex');

  return {
    signature,
    timestamp,
    apiKey: env.CLOUDINARY_API_KEY,
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    folder,
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
  };
};

/** Removes an asset — used when a seller deletes a product image. */
export const destroyAsset = async (publicId: string): Promise<void> => {
  if (!isConfigured) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (error) {
    // A leaked asset costs storage, not correctness; never fail the request for it.
    logger.warn('Could not delete a Cloudinary asset', {
      publicId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

export const isMediaConfigured = (): boolean => isConfigured;
