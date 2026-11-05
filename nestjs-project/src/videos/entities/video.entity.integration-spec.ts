import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generateVideoSlug } from '../slug.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const TEN_GIB = 10 * 1024 * 1024 * 1024;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const n = ++counter;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${n}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${n}`,
        nickname: `video_channel_${n}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    return videoRepository.create({
      channel_id: channelId,
      slug: generateVideoSlug(),
      title: 'aula',
      original_filename: 'aula.mp4',
      content_type: 'video/mp4',
      size_bytes: 157286400,
      ...overrides,
    });
  }

  it('should persist a video without status as draft', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.upload_id).toBeNull();
    expect(found.created_at).toBeInstanceOf(Date);
  });

  it('should reject two videos with the same slug', async () => {
    const channel = await createChannel();
    const slug = generateVideoSlug();
    await videoRepository.save(buildVideo(channel.id, { slug }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { slug })),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('should reject a status outside the video_status enum', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "slug", "title", "status", "original_filename", "content_type", "size_bytes")
         VALUES ($1, $2, 'aula', 'published', 'aula.mp4', 'video/mp4', 1)`,
        [channel.id, generateVideoSlug()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '22P02' } });
  });

  it('should delete the videos of a channel when the channel is deleted', async () => {
    const channel = await createChannel();
    const other = await createChannel();
    await videoRepository.save(buildVideo(channel.id));
    await videoRepository.save(buildVideo(channel.id));
    const kept = await videoRepository.save(buildVideo(other.id));

    await channelRepository.delete({ id: channel.id });

    expect(await videoRepository.countBy({ channel_id: channel.id })).toBe(0);
    expect(await videoRepository.findOneBy({ id: kept.id })).not.toBeNull();
  });

  it('should read a 10 GiB size_bytes back as the exact number', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel.id, { size_bytes: TEN_GIB }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(10737418240);
    expect(typeof found.size_bytes).toBe('number');
  });
});
