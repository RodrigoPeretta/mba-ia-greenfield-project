import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { videoObjectKeys } from '../storage/video-object-keys';
import type { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import {
  PG_UNIQUE_VIOLATION,
  VIDEO_CONTENT_TYPE_PATTERN,
  VIDEO_SLUG_COLUMN,
  VIDEO_SLUG_MAX_ATTEMPTS,
  VIDEO_TITLE_MAX_LENGTH,
} from './videos.constants';
import type { PresignPartsResponseDto } from './dto/presign-parts-response.dto';
import type { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
import {
  InvalidPartNumberException,
  InvalidVideoStateException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';

interface PgDriverError {
  code?: unknown;
  detail?: unknown;
}

function isSlugUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & PgDriverError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(VIDEO_SLUG_COLUMN)
  );
}

/** "aula.mp4" → "aula"; names without a usable base keep the full filename. */
export function titleFromFilename(filename: string): string {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf('.');
  const base = lastDot > 0 ? trimmed.slice(0, lastDot).trim() : trimmed;
  return (base || trimmed).slice(0, VIDEO_TITLE_MAX_LENGTH);
}

@Injectable()
export class VideoUploadsService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async initiate(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    if (!VIDEO_CONTENT_TYPE_PATTERN.test(dto.content_type)) {
      throw new UnsupportedVideoTypeException();
    }
    if (dto.size_bytes > this.config.maxSizeBytes) {
      throw new VideoTooLargeException(this.config.maxSizeBytes);
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`Channel not found for user ${userId}`);
    }

    const video = await this.saveDraft(channel.id, dto);

    let uploadId: string;
    try {
      uploadId = await this.storageService.createMultipartUpload(
        videoObjectKeys(video.id).original,
        dto.content_type,
      );
    } catch (error) {
      await this.videoRepository.delete({ id: video.id });
      throw error;
    }
    await this.videoRepository.update(
      { id: video.id },
      { upload_id: uploadId },
    );

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: VideoStatus.DRAFT,
      size_bytes: video.size_bytes,
      upload: {
        part_size: this.config.uploadPartSizeBytes,
        part_count: this.partCount(dto.size_bytes),
      },
    };
  }

  async presignParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<PresignPartsResponseDto> {
    const { video, uploadId } = await this.findOwnDraft(userId, videoId);
    const partCount = this.partCount(video.size_bytes);
    if (partNumbers.some((n) => n < 1 || n > partCount)) {
      throw new InvalidPartNumberException(partCount);
    }

    const key = videoObjectKeys(video.id).original;
    const expiresIn = this.config.uploadUrlTtlSeconds;
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          key,
          uploadId,
          partNumber,
          expiresIn,
        ),
      })),
    );
    return { parts, expires_in: expiresIn };
  }

  async listUploadedParts(
    userId: string,
    videoId: string,
  ): Promise<UploadedPartsResponseDto> {
    const { video, uploadId } = await this.findOwnDraft(userId, videoId);
    const parts = await this.storageService.listParts(
      videoObjectKeys(video.id).original,
      uploadId,
    );
    return {
      parts,
      part_size: this.config.uploadPartSizeBytes,
      part_count: this.partCount(video.size_bytes),
    };
  }

  /** Aborts the multipart (an already gone upload is fine) and removes the draft. */
  async cancel(userId: string, videoId: string): Promise<void> {
    const { video, uploadId } = await this.findOwnDraft(userId, videoId);
    await this.storageService.abortMultipartUpload(
      videoObjectKeys(video.id).original,
      uploadId,
    );
    await this.videoRepository.delete({ id: video.id });
  }

  /**
   * Single query filtered by the caller's channel: a missing video and someone
   * else's video both yield VIDEO_NOT_FOUND.
   */
  private async findOwnDraft(
    userId: string,
    videoId: string,
  ): Promise<{ video: Video; uploadId: string }> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId, channel: { user_id: userId } },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidVideoStateException(video.status);
    }
    return { video, uploadId: video.upload_id };
  }

  private partCount(sizeBytes: number): number {
    return Math.ceil(sizeBytes / this.config.uploadPartSizeBytes);
  }

  private async saveDraft(
    channelId: string,
    dto: InitiateUploadDto,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            channel_id: channelId,
            slug: generateVideoSlug(),
            title: titleFromFilename(dto.filename),
            status: VideoStatus.DRAFT,
            original_filename: dto.filename,
            content_type: dto.content_type,
            size_bytes: dto.size_bytes,
          }),
        );
      } catch (error) {
        if (
          !isSlugUniqueViolation(error) ||
          attempt >= VIDEO_SLUG_MAX_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  }
}
