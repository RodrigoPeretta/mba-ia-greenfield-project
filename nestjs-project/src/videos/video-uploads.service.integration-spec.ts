import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { videoObjectKeys } from '../storage/video-object-keys';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoUploadsService (integration — DB + MinIO)', () => {
  let module: TestingModule;
  let service: VideoUploadsService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    service = module.get(VideoUploadsService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await abortOpenUploads();
    await module.close();
  });

  beforeEach(async () => {
    await abortOpenUploads();
    await cleanAllTables(dataSource);
  });

  /** MinIO lists multipart uploads only by exact key, so abort through the persisted upload ids. */
  async function abortOpenUploads(): Promise<void> {
    const videos = await videoRepository.find();
    for (const video of videos) {
      if (video.upload_id) {
        await storage.abortMultipartUpload(
          videoObjectKeys(video.id).original,
          video.upload_id,
        );
      }
    }
  }

  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await dataSource.getRepository(User).save({
      email: 'uploader@example.com',
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'uploader',
      nickname: 'uploader',
      user_id: user.id,
    });
    return { user, channel };
  }

  it('should persist the draft with upload_id and open the multipart on videos/{id}/original', async () => {
    const { user, channel } = await createUserWithChannel();

    const result = await service.initiate(user.id, {
      filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 157286400,
    });

    const saved = await videoRepository.findOneByOrFail({ id: result.id });
    expect(saved).toMatchObject({
      channel_id: channel.id,
      slug: result.slug,
      title: 'aula',
      status: VideoStatus.DRAFT,
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 157286400,
    });
    expect(saved.upload_id).toEqual(expect.any(String));
    await expect(
      storage.listParts(videoObjectKeys(saved.id).original, saved.upload_id!),
    ).resolves.toEqual([]);
  });

  it('should remove the draft from the DB when the storage fails to open the multipart', async () => {
    const { user } = await createUserWithChannel();
    const storageError = new Error('storage down');
    const spy = jest
      .spyOn(storage, 'createMultipartUpload')
      .mockRejectedValueOnce(storageError);

    await expect(
      service.initiate(user.id, {
        filename: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      }),
    ).rejects.toBe(storageError);

    expect(await videoRepository.count()).toBe(0);
    spy.mockRestore();
  });
});
