import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosModule', () => {
  it('should compile and resolve the Video repository, upload service and controller', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(VideoUploadsService)).toBeInstanceOf(VideoUploadsService);
    expect(module.get(VideosController)).toBeInstanceOf(VideosController);
    await module.close();
  }, 15000);
});
