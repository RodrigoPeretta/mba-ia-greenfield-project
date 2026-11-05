import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { VideoUploadsService } from './video-uploads.service';

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videoUploadsService: VideoUploadsService) {}

  @Post()
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers the video as a draft in the caller's channel, opens a multipart upload in the object storage and returns the part plan. The bytes go straight to the storage through signed URLs.",
  })
  @ApiBody({ type: InitiateUploadDto })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload opened',
    type: InitiateUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'UNSUPPORTED_VIDEO_TYPE — content_type is not video/*',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'VIDEO_TOO_LARGE — size_bytes above the limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResponseDto> {
    return this.videoUploadsService.initiate(user.sub, dto);
  }
}
