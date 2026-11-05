import { randomBytes } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import storageConfig from '../src/config/storage.config';
import { StorageService } from '../src/storage/storage.service';
import { videoObjectKeys } from '../src/storage/video-object-keys';
import { Video } from '../src/videos/entities/video.entity';
import {
  createConfirmedUser,
  createVideosE2eApp,
  type E2eUser,
  resetVideosState,
} from './helpers/videos-e2e.helpers';

interface PartsBody {
  parts?: { part_number: number; url?: string; etag?: string; size?: number }[];
  expires_in?: number;
  part_size?: number;
  part_count?: number;
  statusCode?: number;
  error?: string;
}

const bodyOf = (res: request.Response): PartsBody => res.body as PartsBody;

const PART_BYTES = 5 * 1024 * 1024;

/** PUTs the bytes straight to the signed URL, without rewriting it. */
async function putToPresignedUrl(url: string, body: Buffer): Promise<Response> {
  return fetch(url, { method: 'PUT', body: Uint8Array.from(body) });
}

describe('videos-upload-parts', () => {
  let app: INestApplication<App>;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let publicEndpoint: string;
  let owner: E2eUser;
  let other: E2eUser;
  let videoId: string;

  beforeAll(async () => {
    app = await createVideosE2eApp();
    videoRepository = app.get(DataSource).getRepository(Video);
    storage = app.get(StorageService);
    publicEndpoint = app.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).publicEndpoint;
  });

  afterAll(async () => {
    await resetVideosState(app);
    await app.close();
  });

  beforeEach(async () => {
    await resetVideosState(app);
    owner = await createConfirmedUser(app, 'owner@example.com');
    other = await createConfirmedUser(app, 'other@example.com');
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        filename: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 157286400,
      })
      .expect(201);
    videoId = (res.body as { id: string }).id;
  });

  const http = () => request(app.getHttpServer());
  const auth = (user: E2eUser) => `Bearer ${user.accessToken}`;
  const partUrls = (body: object, user: E2eUser = owner) =>
    http()
      .post(`/videos/${videoId}/upload/part-urls`)
      .set('Authorization', auth(user))
      .send(body);
  const listParts = (user: E2eUser = owner) =>
    http()
      .get(`/videos/${videoId}/upload/parts`)
      .set('Authorization', auth(user));
  const cancel = (user: E2eUser = owner) =>
    http().delete(`/videos/${videoId}/upload`).set('Authorization', auth(user));

  async function uploadPartOne(): Promise<string> {
    const res = await partUrls({ part_numbers: [1] }).expect(200);
    const response = await putToPresignedUrl(
      bodyOf(res).parts![0].url!,
      randomBytes(PART_BYTES),
    );
    expect(response.status).toBe(200);
    const etag = response.headers.get('etag');
    expect(etag).toBeTruthy();
    return etag!;
  }

  // 1. URLs assinadas e retomada do upload

  it('part-urls-retorna-urls-publicas-com-ttl', async () => {
    const res = await partUrls({ part_numbers: [1, 2] }).expect(200);

    const body = bodyOf(res);
    expect(body.expires_in).toBe(3600);
    expect(body.parts!.map((p) => p.part_number)).toEqual([1, 2]);
    for (const part of body.parts!) {
      const url = new URL(part.url!);
      expect(url.origin).toBe(new URL(publicEndpoint).origin);
      expect(url.searchParams.get('partNumber')).toBe(String(part.part_number));
      expect(url.searchParams.get('uploadId')).toBeTruthy();
    }
  });

  it('parte-enviada-aparece-na-listagem', async () => {
    const etag = await uploadPartOne();

    const res = await listParts().expect(200);

    expect(bodyOf(res)).toEqual({
      parts: [{ part_number: 1, etag, size: PART_BYTES }],
      part_size: 67108864,
      part_count: 3,
    });
  });

  it('numero-de-parte-fora-do-intervalo-retorna-422', async () => {
    const res = await partUrls({ part_numbers: [999] }).expect(422);

    expect(bodyOf(res).error).toBe('INVALID_PART_NUMBER');
  });

  it('lista-de-partes-vazia-retorna-400', async () => {
    const res = await partUrls({ part_numbers: [] }).expect(400);

    expect(bodyOf(res).statusCode).toBe(400);
  });

  // 2. Cancelamento do upload

  it('cancelar-aborta-multipart-e-remove-rascunho', async () => {
    await uploadPartOne();
    const { upload_id: uploadId } = await videoRepository.findOneByOrFail({
      id: videoId,
    });

    const res = await cancel().expect(204);

    expect(res.text).toBe('');
    expect(await videoRepository.findOneBy({ id: videoId })).toBeNull();
    await expect(
      storage.listParts(videoObjectKeys(videoId).original, uploadId!),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });

    const after = await listParts().expect(404);
    expect(bodyOf(after).error).toBe('VIDEO_NOT_FOUND');
  });

  // 3. Isolamento por dono e validação de parâmetro

  it('outro-usuario-recebe-404-nas-tres-rotas', async () => {
    const before = await videoRepository.findOneByOrFail({ id: videoId });

    const presign = await partUrls({ part_numbers: [1] }, other).expect(404);
    expect(bodyOf(presign).error).toBe('VIDEO_NOT_FOUND');

    const list = await listParts(other).expect(404);
    expect(bodyOf(list).error).toBe('VIDEO_NOT_FOUND');

    const del = await cancel(other).expect(404);
    expect(bodyOf(del).error).toBe('VIDEO_NOT_FOUND');

    const after = await videoRepository.findOneByOrFail({ id: videoId });
    expect(after.upload_id).toBe(before.upload_id);
  });

  it('id-nao-uuid-retorna-400', async () => {
    await http()
      .get('/videos/not-a-uuid/upload/parts')
      .set('Authorization', auth(owner))
      .expect(400);
  });
});
