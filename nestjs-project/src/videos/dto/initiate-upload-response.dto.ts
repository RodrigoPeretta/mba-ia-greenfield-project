import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class UploadPlanDto {
  @ApiProperty({
    description: 'Size of every part in bytes (the last one may be smaller)',
    example: 67108864,
  })
  part_size: number;

  @ApiProperty({
    description:
      'Number of parts the client must upload: ceil(size_bytes / part_size)',
    example: 3,
  })
  part_count: number;
}

export class InitiateUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    description: 'Unique 11-char base64url URL of the video',
    example: 'dQw4w9WgXcQ',
  })
  slug: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ example: 157286400 })
  size_bytes: number;

  @ApiProperty({ type: UploadPlanDto })
  upload: UploadPlanDto;
}
