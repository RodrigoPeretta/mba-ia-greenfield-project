import { VideoStatus } from '../entities/video.entity';

export class UploadPlanDto {
  /** Size of every part in bytes (the last one may be smaller). */
  part_size: number;

  /** Number of parts the client must upload: `ceil(size_bytes / part_size)`. */
  part_count: number;
}

export class InitiateUploadResponseDto {
  id: string;

  /** Unique 11-char base64url URL of the video. */
  slug: string;

  title: string;

  status: VideoStatus;

  size_bytes: number;

  upload: UploadPlanDto;
}
