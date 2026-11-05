import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { videoObjectKeys } from '../src/storage/video-object-keys';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  createConfirmedUser,
  createVideosE2eApp,
  type E2eUser,
  resetVideosState,
} from './helpers/videos-e2e.helpers';

interface InitiateUploadBody {
  id?: string;
  slug?: string;
  title?: string;
  status?: string;
  size_bytes?: number;
  upload?: { part_size: number; part_count: number };
  statusCode?: number;
  error?: string;
  message?: string | string[];
}

const bodyOf = (res: request.Response): InitiateUploadBody =>
  res.body as InitiateUploadBody;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const VALID_BODY = {
  filename: 'aula.mp4',
  content_type: 'video/mp4',
  size_bytes: 157286400,
};

describe('videos-initiate-upload', () => {
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let owner: E2eUser;

  beforeAll(async () => {
    app = await createVideosE2eApp();
    videoRepository = app.get(DataSource).getRepository(Video);
    storage = app.get(StorageService);
  });

  afterAll(async () => {
    await resetVideosState(app);
    await app.close();
  });

  beforeEach(async () => {
    await resetVideosState(app);
    owner = await createConfirmedUser(app, 'uploader@example.com');
  });

  const initiate = (body: object, token: string | null = owner.accessToken) => {
    const req = request(app.getHttpServer()).post('/videos');
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };

  // 1. Pré-cadastro do rascunho e início do multipart

  it('inicia-upload-retorna-rascunho-e-plano-de-partes', async () => {
    const res = await initiate(VALID_BODY).expect(201);

    const body = bodyOf(res);
    expect(body.id).toMatch(UUID_PATTERN);
    expect(body.slug).toMatch(SLUG_PATTERN);
    expect(body).toMatchObject({
      title: 'aula',
      status: 'draft',
      size_bytes: 157286400,
      upload: { part_size: 67108864, part_count: 3 },
    });

    const video = await videoRepository.findOneByOrFail({ id: body.id });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.channel_id).toBe(owner.channel.id);
    expect(video.upload_id).not.toBeNull();

    await expect(
      storage.listParts(videoObjectKeys(video.id).original, video.upload_id!),
    ).resolves.toEqual([]);
  });

  it('slugs-distintos-entre-uploads', async () => {
    const first = await initiate(VALID_BODY).expect(201);
    const second = await initiate(VALID_BODY).expect(201);

    expect(bodyOf(first).slug).not.toBe(bodyOf(second).slug);
    expect(bodyOf(first).id).not.toBe(bodyOf(second).id);
  });

  // 2. Rejeições de entrada e de autenticação

  it('content-type-nao-video-retorna-415', async () => {
    const res = await initiate({
      filename: 'foto.png',
      content_type: 'image/png',
      size_bytes: 1024,
    }).expect(415);

    const body = bodyOf(res);
    expect(Object.keys(body).sort()).toEqual([
      'error',
      'message',
      'statusCode',
    ]);
    expect(body).toMatchObject({
      statusCode: 415,
      error: 'UNSUPPORTED_VIDEO_TYPE',
    });
    expect(typeof body.message).toBe('string');
    expect(await videoRepository.count()).toBe(0);
  });

  it('tamanho-acima-de-10gib-retorna-422', async () => {
    const res = await initiate({
      filename: 'grande.mp4',
      content_type: 'video/mp4',
      size_bytes: 10737418241,
    }).expect(422);

    expect(bodyOf(res).error).toBe('VIDEO_TOO_LARGE');
    // No row means no upload id and no object key: the check runs before the storage is touched.
    expect(await videoRepository.count()).toBe(0);
  });

  it('body-invalido-retorna-400', async () => {
    const res = await initiate({
      content_type: 'video/mp4',
      size_bytes: 1024,
    }).expect(400);

    expect(bodyOf(res).statusCode).toBe(400);
    expect(bodyOf(res).message).toBeDefined();
    expect(await videoRepository.count()).toBe(0);
  });

  it('sem-token-retorna-401', async () => {
    await initiate(VALID_BODY, null).expect(401);

    expect(await videoRepository.count()).toBe(0);
  });
});
