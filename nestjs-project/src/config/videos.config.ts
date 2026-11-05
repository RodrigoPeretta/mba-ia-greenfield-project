import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  uploadUrlTtlSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_TTL_SECONDS || '3600',
    10,
  ),
  playbackUrlTtlSeconds: parseInt(
    process.env.VIDEO_PLAYBACK_URL_TTL_SECONDS || '14400',
    10,
  ),
  abandonedUploadHours: parseInt(
    process.env.VIDEO_ABANDONED_UPLOAD_HOURS || '24',
    10,
  ),
  processingStaleMinutes: parseInt(
    process.env.VIDEO_PROCESSING_STALE_MINUTES || '60',
    10,
  ),
}));
