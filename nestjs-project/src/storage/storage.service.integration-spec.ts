import { randomBytes, randomUUID } from 'crypto';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;
const URL_TTL_SECONDS = 300;

/** PUTs bytes to a presigned part URL and returns the ETag reported by the storage. */
const putPart = async (url: string, body: Buffer): Promise<string> => {
  const response = await fetch(url, {
    method: 'PUT',
    body: Uint8Array.from(body),
  });
  expect(response.status).toBe(200);
  const etag = response.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag!;
};

describe('StorageService (integration — MinIO)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let config: ConfigType<typeof storageConfig>;
  const keysToDelete: string[] = [];

  const newKey = (): string => {
    const key = `test/storage-spec/${randomUUID()}`;
    keysToDelete.push(key);
    return key;
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    config = module.get(storageConfig.KEY);
  });

  afterAll(async () => {
    await Promise.all(keysToDelete.map((key) => storage.deleteObject(key)));
    await module.close();
  });

  describe('multipart upload', () => {
    it('should assemble parts uploaded through signed URLs into one object', async () => {
      const key = newKey();
      const part1 = randomBytes(MIN_PART_SIZE);
      const part2 = randomBytes(1024);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const etag1 = await putPart(
        await storage.presignUploadPart(key, uploadId, 1, URL_TTL_SECONDS),
        part1,
      );
      const etag2 = await putPart(
        await storage.presignUploadPart(key, uploadId, 2, URL_TTL_SECONDS),
        part2,
      );
      const result = await storage.completeMultipartUpload(key, uploadId, [
        { part_number: 2, etag: etag2 },
        { part_number: 1, etag: etag1 },
      ]);

      expect(result).toEqual({ ok: true });
      const head = await storage.headObject(key);
      expect(head).toEqual({
        contentLength: part1.length + part2.length,
        contentType: 'video/mp4',
      });
    });

    it('should list exactly the parts received so far', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const part1 = randomBytes(MIN_PART_SIZE);
      const etag = await putPart(
        await storage.presignUploadPart(key, uploadId, 1, URL_TTL_SECONDS),
        part1,
      );

      const parts = await storage.listParts(key, uploadId);

      expect(parts).toEqual([{ part_number: 1, etag, size: part1.length }]);
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should report invalid parts as a typed result instead of throwing', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await putPart(
        await storage.presignUploadPart(key, uploadId, 1, URL_TTL_SECONDS),
        randomBytes(1024),
      );

      const result = await storage.completeMultipartUpload(key, uploadId, [
        { part_number: 1, etag: '"00000000000000000000000000000000"' },
      ]);

      expect(result).toEqual({ ok: false, reason: 'INVALID_PARTS' });
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should make the upload unreachable after abort', async () => {
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const aborted = await storage.abortMultipartUpload(key, uploadId);

      expect(aborted).toBe(true);
      const error: unknown = await storage
        .listParts(key, uploadId)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(S3ServiceException);
      expect((error as S3ServiceException).name).toBe('NoSuchUpload');
    });

    it('should not throw when aborting an upload that was already aborted', async () => {
      // MinIO answers a repeated abort with success; AWS S3 answers NoSuchUpload,
      // which the service maps to `false`. Either way cleanup must not throw.
      const key = newKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toEqual(expect.any(Boolean));
    });
  });

  describe('objects', () => {
    it('should put, head and delete an object', async () => {
      const key = newKey();
      const body = Buffer.from('thumbnail-bytes');

      await storage.putObject(key, body, 'image/jpeg');
      expect(await storage.headObject(key)).toEqual({
        contentLength: body.length,
        contentType: 'image/jpeg',
      });

      await storage.deleteObject(key);
      expect(await storage.headObject(key)).toBeNull();
    });
  });

  describe('signed GET URLs', () => {
    it('should serve the attachment Content-Disposition signed into the URL', async () => {
      const key = newKey();
      await storage.putObject(key, Buffer.from('video'), 'video/mp4');

      const url = await storage.presignGetObject(key, {
        audience: 'internal',
        expiresIn: URL_TTL_SECONDS,
        contentDisposition: 'attachment; filename="aula final.mp4"',
      });
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="aula final.mp4"',
      );
    });

    it('should sign public URLs with S3_PUBLIC_ENDPOINT and internal ones with S3_ENDPOINT', async () => {
      // Signing is offline: a distinct public host proves which client signed each URL.
      const publicEndpoint = 'http://public.streamtube.test:9000';
      const signingModule = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
          StorageModule,
        ],
      })
        .overrideProvider(storageConfig.KEY)
        .useValue({ ...config, publicEndpoint })
        .compile();
      const signer = signingModule.get(StorageService);

      const publicUrl = await signer.presignGetObject('videos/x/original', {
        audience: 'public',
        expiresIn: URL_TTL_SECONDS,
      });
      const internalUrl = await signer.presignGetObject('videos/x/original', {
        audience: 'internal',
        expiresIn: URL_TTL_SECONDS,
      });
      const partUrl = await signer.presignUploadPart(
        'videos/x/original',
        'upload-id',
        1,
        URL_TTL_SECONDS,
      );

      expect(new URL(publicUrl).origin).toBe(publicEndpoint);
      expect(new URL(partUrl).origin).toBe(publicEndpoint);
      expect(new URL(internalUrl).origin).toBe(new URL(config.endpoint).origin);
      await signingModule.close();
    });
  });
});
