import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  titleFromFilename,
  VideoUploadsService,
} from './video-uploads.service';
import {
  InvalidPartNumberException,
  InvalidVideoStateException,
  UnsupportedVideoTypeException,
  VideoNotFoundException,
  VideoTooLargeException,
} from './videos.exceptions';

const PART_SIZE = 64 * 1024 * 1024;
const MAX_SIZE = 10 * 1024 * 1024 * 1024;
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const VIDEO_ID = 'v0000000-0000-4000-8000-000000000001';
const URL_TTL = 3600;
const ORIGINAL_KEY = `videos/${VIDEO_ID}/original`;

const slugViolation = (): QueryFailedError =>
  new QueryFailedError('INSERT', [], {
    code: '23505',
    detail: 'Key (slug)=(abc) already exists.',
  } as unknown as Error);

describe('VideoUploadsService', () => {
  let service: VideoUploadsService;
  const repo = {
    create: jest.fn((data: Partial<Video>) => data),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findOne: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };

  const validDto = {
    filename: 'aula.mp4',
    content_type: 'video/mp4',
    size_bytes: 157286400,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    repo.save.mockImplementation((data: Partial<Video>) =>
      Promise.resolve({ ...data, id: VIDEO_ID }),
    );
    channelsService.findByUserId.mockResolvedValue({ id: CHANNEL_ID });
    storageService.createMultipartUpload.mockResolvedValue('upload-1');

    const module = await Test.createTestingModule({
      providers: [
        VideoUploadsService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        {
          provide: videosConfig.KEY,
          useValue: {
            maxSizeBytes: MAX_SIZE,
            uploadPartSizeBytes: PART_SIZE,
            uploadUrlTtlSeconds: URL_TTL,
          },
        },
      ],
    }).compile();
    service = module.get(VideoUploadsService);
  });

  it('should reject a content type outside video/* before touching DB or storage', async () => {
    await expect(
      service.initiate('user-1', { ...validDto, content_type: 'image/png' }),
    ).rejects.toBeInstanceOf(UnsupportedVideoTypeException);

    expect(repo.save).not.toHaveBeenCalled();
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should reject a size above the ceiling before touching DB or storage', async () => {
    await expect(
      service.initiate('user-1', { ...validDto, size_bytes: MAX_SIZE + 1 }),
    ).rejects.toBeInstanceOf(VideoTooLargeException);

    expect(repo.save).not.toHaveBeenCalled();
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should accept a size exactly at the ceiling', async () => {
    const result = await service.initiate('user-1', {
      ...validDto,
      size_bytes: MAX_SIZE,
    });

    expect(result.upload.part_count).toBe(160);
  });

  it('should retry the slug on a slug unique violation and succeed', async () => {
    repo.save
      .mockRejectedValueOnce(slugViolation())
      .mockRejectedValueOnce(slugViolation());

    const result = await service.initiate('user-1', validDto);

    expect(repo.save).toHaveBeenCalledTimes(3);
    const slugs = repo.create.mock.calls.map(([data]) => data.slug);
    expect(new Set(slugs).size).toBe(3);
    expect(result.id).toBe(VIDEO_ID);
  });

  it('should give up after 3 slug collisions without opening the multipart', async () => {
    repo.save.mockRejectedValue(slugViolation());

    await expect(service.initiate('user-1', validDto)).rejects.toBeInstanceOf(
      QueryFailedError,
    );
    expect(repo.save).toHaveBeenCalledTimes(3);
    expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should not retry on a non-slug database error', async () => {
    repo.save.mockRejectedValueOnce(new Error('connection lost'));

    await expect(service.initiate('user-1', validDto)).rejects.toThrow(
      'connection lost',
    );
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('should delete the draft and rethrow when the storage fails', async () => {
    const storageError = new Error('storage down');
    storageService.createMultipartUpload.mockRejectedValueOnce(storageError);

    await expect(service.initiate('user-1', validDto)).rejects.toBe(
      storageError,
    );
    expect(repo.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('should open the multipart on the original key and persist the upload id', async () => {
    const result = await service.initiate('user-1', validDto);

    expect(channelsService.findByUserId).toHaveBeenCalledWith('user-1');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: CHANNEL_ID }),
    );
    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      `videos/${VIDEO_ID}/original`,
      'video/mp4',
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: VIDEO_ID },
      { upload_id: 'upload-1' },
    );
    expect(result).toMatchObject({
      title: 'aula',
      status: VideoStatus.DRAFT,
      size_bytes: 157286400,
      upload: { part_size: PART_SIZE, part_count: 3 },
    });
  });

  it.each([
    [1, 1],
    [PART_SIZE, 1],
    [PART_SIZE + 1, 2],
    [3 * PART_SIZE, 3],
  ])('should compute part_count for %i bytes as %i', async (size, count) => {
    const result = await service.initiate('user-1', {
      ...validDto,
      size_bytes: size,
    });

    expect(result.upload.part_count).toBe(count);
  });

  describe('own draft operations', () => {
    const draft = (overrides: Partial<Video> = {}): Partial<Video> => ({
      id: VIDEO_ID,
      channel_id: CHANNEL_ID,
      status: VideoStatus.DRAFT,
      size_bytes: 157286400,
      upload_id: 'upload-1',
      ...overrides,
    });

    const operations: [string, () => Promise<unknown>][] = [
      ['presignParts', () => service.presignParts('user-1', VIDEO_ID, [1])],
      [
        'listUploadedParts',
        () => service.listUploadedParts('user-1', VIDEO_ID),
      ],
      ['cancel', () => service.cancel('user-1', VIDEO_ID)],
    ];

    it('should look the video up by id filtered by the caller channel owner', async () => {
      repo.findOne.mockResolvedValue(draft());
      storageService.listParts.mockResolvedValue([]);

      await service.listUploadedParts('user-1', VIDEO_ID);

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: VIDEO_ID, channel: { user_id: 'user-1' } },
      });
    });

    it.each(operations)(
      '%s should throw VideoNotFoundException for a missing or foreign video',
      async (_name, run) => {
        repo.findOne.mockResolvedValue(null);

        await expect(run()).rejects.toBeInstanceOf(VideoNotFoundException);
        expect(storageService.presignUploadPart).not.toHaveBeenCalled();
        expect(storageService.listParts).not.toHaveBeenCalled();
        expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      },
    );

    it.each(operations)(
      '%s should throw InvalidVideoStateException for a video outside draft',
      async (_name, run) => {
        repo.findOne.mockResolvedValue(
          draft({ status: VideoStatus.PROCESSING }),
        );

        await expect(run()).rejects.toBeInstanceOf(InvalidVideoStateException);
        expect(repo.delete).not.toHaveBeenCalled();
      },
    );

    describe('presignParts', () => {
      beforeEach(() => {
        repo.findOne.mockResolvedValue(draft());
        storageService.presignUploadPart.mockImplementation(
          (_key: string, _uploadId: string, n: number) =>
            Promise.resolve(`http://minio:9000/signed?partNumber=${n}`),
        );
      });

      it.each([[[0]], [[4]], [[1, 999]]])(
        'should reject %j in a 3-part upload with InvalidPartNumberException',
        async (partNumbers) => {
          await expect(
            service.presignParts('user-1', VIDEO_ID, partNumbers),
          ).rejects.toBeInstanceOf(InvalidPartNumberException);
          expect(storageService.presignUploadPart).not.toHaveBeenCalled();
        },
      );

      it('should sign every requested part with the upload TTL', async () => {
        const result = await service.presignParts('user-1', VIDEO_ID, [1, 3]);

        expect(storageService.presignUploadPart).toHaveBeenCalledWith(
          ORIGINAL_KEY,
          'upload-1',
          1,
          URL_TTL,
        );
        expect(storageService.presignUploadPart).toHaveBeenCalledWith(
          ORIGINAL_KEY,
          'upload-1',
          3,
          URL_TTL,
        );
        expect(result).toEqual({
          parts: [
            { part_number: 1, url: 'http://minio:9000/signed?partNumber=1' },
            { part_number: 3, url: 'http://minio:9000/signed?partNumber=3' },
          ],
          expires_in: URL_TTL,
        });
      });
    });

    describe('listUploadedParts', () => {
      it('should return the storage parts with the part plan', async () => {
        repo.findOne.mockResolvedValue(draft());
        const parts = [{ part_number: 1, etag: '"e1"', size: 5242880 }];
        storageService.listParts.mockResolvedValue(parts);

        const result = await service.listUploadedParts('user-1', VIDEO_ID);

        expect(storageService.listParts).toHaveBeenCalledWith(
          ORIGINAL_KEY,
          'upload-1',
        );
        expect(result).toEqual({ parts, part_size: PART_SIZE, part_count: 3 });
      });
    });

    describe('cancel', () => {
      beforeEach(() => {
        repo.findOne.mockResolvedValue(draft());
      });

      it('should abort the multipart and delete the draft', async () => {
        storageService.abortMultipartUpload.mockResolvedValue(true);

        await service.cancel('user-1', VIDEO_ID);

        expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
          ORIGINAL_KEY,
          'upload-1',
        );
        expect(repo.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
      });

      it('should still delete the draft when the upload is already gone (NoSuchUpload)', async () => {
        storageService.abortMultipartUpload.mockResolvedValue(false);

        await service.cancel('user-1', VIDEO_ID);

        expect(repo.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
      });

      it('should keep the draft when the abort fails for another reason', async () => {
        storageService.abortMultipartUpload.mockRejectedValue(
          new Error('storage down'),
        );

        await expect(service.cancel('user-1', VIDEO_ID)).rejects.toThrow(
          'storage down',
        );
        expect(repo.delete).not.toHaveBeenCalled();
      });
    });
  });
});

describe('titleFromFilename', () => {
  it.each([
    ['aula.mp4', 'aula'],
    ['minha.aula.final.mkv', 'minha.aula.final'],
    ['semextensao', 'semextensao'],
    ['.mp4', '.mp4'],
    ['a'.repeat(150) + '.mp4', 'a'.repeat(100)],
  ])('should derive "%s" as "%s"', (filename, title) => {
    expect(titleFromFilename(filename)).toBe(title);
  });
});
