import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  S3_ERROR_NAMES,
  S3_INTERNAL_CLIENT,
  S3_PUBLIC_CLIENT,
} from './storage.constants';

export interface UploadedPart {
  part_number: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  part_number: number;
  etag: string;
}

export type CompleteMultipartUploadResult =
  | { ok: true }
  | { ok: false; reason: 'INVALID_PARTS' | 'NO_SUCH_UPLOAD' };

export interface ObjectHead {
  contentLength: number;
  contentType: string | undefined;
}

export type SignedUrlAudience = 'public' | 'internal';

export interface PresignGetObjectOptions {
  audience: SignedUrlAudience;
  expiresIn: number;
  contentDisposition?: string;
}

const INVALID_PARTS_ERRORS: ReadonlySet<string> = new Set([
  S3_ERROR_NAMES.INVALID_PART,
  S3_ERROR_NAMES.INVALID_PART_ORDER,
  S3_ERROR_NAMES.ENTITY_TOO_SMALL,
]);

const isS3Error = (error: unknown, names: ReadonlySet<string>): boolean =>
  error instanceof S3ServiceException && names.has(error.name);

@Injectable()
export class StorageService implements OnModuleDestroy {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId!;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  /** Throws the SDK `NoSuchUpload` error when the upload no longer exists. */
  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          part_number: part.PartNumber!,
          etag: part.ETag!,
          size: part.Size!,
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<CompleteMultipartUploadResult> {
    const ordered = [...parts].sort((a, b) => a.part_number - b.part_number);
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({
              PartNumber: part.part_number,
              ETag: part.etag,
            })),
          },
        }),
      );
      return { ok: true };
    } catch (error) {
      if (isS3Error(error, INVALID_PARTS_ERRORS)) {
        return { ok: false, reason: 'INVALID_PARTS' };
      }
      if (isS3Error(error, new Set([S3_ERROR_NAMES.NO_SUCH_UPLOAD]))) {
        return { ok: false, reason: 'NO_SUCH_UPLOAD' };
      }
      throw error;
    }
  }

  /** Returns `false` when the upload was already gone (`NoSuchUpload`). */
  async abortMultipartUpload(key: string, uploadId: string): Promise<boolean> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
      return true;
    } catch (error) {
      if (isS3Error(error, new Set([S3_ERROR_NAMES.NO_SUCH_UPLOAD]))) {
        return false;
      }
      throw error;
    }
  }

  /** Returns `null` when the object does not exist. */
  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (error) {
      if (
        isS3Error(
          error,
          new Set([S3_ERROR_NAMES.NOT_FOUND, S3_ERROR_NAMES.NO_SUCH_KEY]),
        )
      ) {
        return null;
      }
      throw error;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Idempotent: deleting a missing key succeeds (S3 semantics). */
  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }

  async presignGetObject(
    key: string,
    options: PresignGetObjectOptions,
  ): Promise<string> {
    const client =
      options.audience === 'public' ? this.publicClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }
}
