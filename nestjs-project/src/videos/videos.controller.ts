import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadResponseDto } from './dto/initiate-upload-response.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PresignPartsResponseDto } from './dto/presign-parts-response.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import { UploadedPartsResponseDto } from './dto/uploaded-parts-response.dto';
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

  @Post(':id/upload/part-urls')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign upload part URLs',
    description:
      'Signs UploadPart URLs on the public storage endpoint for the requested parts of a draft. Used at the start of the upload and to re-sign parts when resuming.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiBody({ type: PresignPartsDto })
  @ApiResponse({
    status: 200,
    description: 'Signed URLs for the requested parts',
    type: PresignPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (id is not a uuid, invalid part_numbers)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "VIDEO_NOT_FOUND — video does not exist or is someone else's",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE — video is not a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'INVALID_PART_NUMBER — a part number is outside 1..part_count',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignPartsDto,
  ): Promise<PresignPartsResponseDto> {
    return this.videoUploadsService.presignParts(
      user.sub,
      id,
      dto.part_numbers,
    );
  }

  @Get(':id/upload/parts')
  @ApiOperation({
    summary: 'List uploaded parts',
    description:
      'Lists the parts the storage has already received, so the client can resume the upload without re-sending them.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiResponse({
    status: 200,
    description: 'Parts received so far and the part plan',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (id is not a uuid)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "VIDEO_NOT_FOUND — video does not exist or is someone else's",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE — video is not a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listUploadedParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videoUploadsService.listUploadedParts(user.sub, id);
  }

  @Delete(':id/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel the upload',
    description:
      'Aborts the multipart upload in the object storage and removes the draft.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Video id' })
  @ApiResponse({ status: 204, description: 'Upload cancelled, draft removed' })
  @ApiResponse({
    status: 400,
    description: 'Validation failed (id is not a uuid)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: "VIDEO_NOT_FOUND — video does not exist or is someone else's",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE — video is not a draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.videoUploadsService.cancel(user.sub, id);
  }
}
