export const S3_INTERNAL_CLIENT = 'S3_INTERNAL_CLIENT';
export const S3_PUBLIC_CLIENT = 'S3_PUBLIC_CLIENT';

/** S3 error names the service translates into typed results instead of throwing. */
export const S3_ERROR_NAMES = {
  NO_SUCH_UPLOAD: 'NoSuchUpload',
  NOT_FOUND: 'NotFound',
  NO_SUCH_KEY: 'NoSuchKey',
  INVALID_PART: 'InvalidPart',
  INVALID_PART_ORDER: 'InvalidPartOrder',
  ENTITY_TOO_SMALL: 'EntityTooSmall',
} as const;
