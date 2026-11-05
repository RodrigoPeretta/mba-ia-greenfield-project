import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

/**
 * The `video/*` pattern and the size ceiling are domain rules checked by the
 * service, so they answer with their own error codes (415 / 422) instead of 400.
 */
export class InitiateUploadDto {
  /** Original file name, used to derive the title. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  /** MIME type of the file; must be `video/*`. */
  @IsString()
  @IsNotEmpty()
  content_type: string;

  /** Declared size in bytes; must not exceed `VIDEO_MAX_SIZE_BYTES`. */
  @IsInt()
  @Min(1)
  size_bytes: number;
}
