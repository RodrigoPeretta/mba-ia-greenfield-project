import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class UnsupportedVideoTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_VIDEO_TYPE', 415, 'Content type must be video/*');
  }
}

export class VideoTooLargeException extends DomainException {
  constructor(maxSizeBytes: number) {
    super(
      'VIDEO_TOO_LARGE',
      422,
      `Video size exceeds the limit of ${maxSizeBytes} bytes`,
    );
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor(status: string) {
    super(
      'INVALID_VIDEO_STATE',
      409,
      `Operation not allowed for a video in status "${status}"`,
    );
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor(partCount: number) {
    super(
      'INVALID_PART_NUMBER',
      422,
      `Part numbers must be between 1 and ${partCount}`,
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor() {
    super(
      'UPLOAD_INCOMPLETE',
      422,
      'Upload could not be completed with the given parts',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}
