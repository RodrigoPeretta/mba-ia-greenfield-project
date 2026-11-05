import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import storageConfig from '../../src/config/storage.config';
import { S3_INTERNAL_CLIENT } from '../../src/storage/storage.constants';
import { StorageService } from '../../src/storage/storage.service';
import { videoObjectKeys } from '../../src/storage/video-object-keys';
import { cleanAllTables } from '../../src/test/create-test-data-source';
import { Channel } from '../../src/channels/entities/channel.entity';
import { User } from '../../src/users/entities/user.entity';
import { UsersService } from '../../src/users/users.service';
import { Video } from '../../src/videos/entities/video.entity';

const VIDEOS_PREFIX = 'videos/';
const TEST_PASSWORD = 'password123';

/** Boots AppModule with the global pipe and filters that `main.ts` registers. */
export async function createVideosE2eApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

/**
 * Aborts the multiparts recorded in `videos.upload_id` (MinIO lists multipart
 * uploads only by exact key, not by prefix), deletes every object under
 * `videos/`, wipes the tables and resets the rate limiter.
 */
export async function resetVideosState(
  app: INestApplication<App>,
): Promise<void> {
  const dataSource = app.get(DataSource);
  const storage = app.get(StorageService);
  const s3 = app.get<S3Client>(S3_INTERNAL_CLIENT);
  const { bucket } = app.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );

  const videos = await dataSource.getRepository(Video).find();
  for (const video of videos) {
    if (video.upload_id) {
      await storage.abortMultipartUpload(
        videoObjectKeys(video.id).original,
        video.upload_id,
      );
    }
  }

  let continuationToken: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: VIDEOS_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = (page.Contents ?? []).map(({ Key }) => ({ Key }));
    if (objects.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
    }
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);

  await cleanAllTables(dataSource);
  app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
}

export interface E2eUser {
  user: User;
  channel: Channel;
  accessToken: string;
}

/** Creates a confirmed user with its channel and logs in through `POST /auth/login`. */
export async function createConfirmedUser(
  app: INestApplication<App>,
  email: string,
): Promise<E2eUser> {
  const dataSource = app.get(DataSource);
  const user = await app
    .get(UsersService)
    .createUserWithChannel(email, await argon2.hash(TEST_PASSWORD));
  await dataSource
    .getRepository(User)
    .update({ id: user.id }, { is_confirmed: true });
  const channel = await dataSource
    .getRepository(Channel)
    .findOneByOrFail({ user_id: user.id });

  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: TEST_PASSWORD })
    .expect(200);

  return {
    user,
    channel,
    accessToken: (res.body as { access_token: string }).access_token,
  };
}
