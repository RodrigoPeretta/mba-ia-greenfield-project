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
  UnsupportedVideoTypeException,
  VideoTooLargeException,
} from './videos.exceptions';

const PART_SIZE = 64 * 1024 * 1024;
const MAX_SIZE = 10 * 1024 * 1024 * 1024;
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const VIDEO_ID = 'v0000000-0000-4000-8000-000000000001';

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
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = { createMultipartUpload: jest.fn() };

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
          useValue: { maxSizeBytes: MAX_SIZE, uploadPartSizeBytes: PART_SIZE },
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
