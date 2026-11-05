import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';
import queueConfig from './queue.config';
import storageConfig from './storage.config';
import videosConfig from './videos.config';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access-key',
  S3_SECRET_KEY: 'secret-key',
};

interface EnvValidationResult {
  error?: ValidationError;
  value: Record<string, string>;
}

const validate = (env: Record<string, string>): EnvValidationResult =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as EnvValidationResult;

const validateWithout = (
  key: keyof typeof requiredEnv,
): EnvValidationResult => {
  const env: Record<string, string> = { ...requiredEnv };
  delete env[key];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  }) as EnvValidationResult;
};

/** Runs `fn` with the given env vars unset, restoring them afterwards. */
const withEnvUnset = <T>(keys: string[], fn: () => T): T => {
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and videos', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'] as const)(
    'should reject a missing %s and name it in the error',
    (key) => {
      const { error } = validateWithout(key);
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should apply the documented defaults when optional variables are unset', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube-videos',
      QUEUE_HOST: 'valkey',
      QUEUE_PORT: 6379,
      QUEUE_PREFIX: 'bull',
      VIDEO_MAX_SIZE_BYTES: 10737418240,
      VIDEO_UPLOAD_PART_SIZE_BYTES: 67108864,
      VIDEO_UPLOAD_URL_TTL_SECONDS: 3600,
      VIDEO_PLAYBACK_URL_TTL_SECONDS: 14400,
      VIDEO_ABANDONED_UPLOAD_HOURS: 24,
      VIDEO_PROCESSING_STALE_MINUTES: 60,
    });
  });

  it('should reject a part size below the S3 minimum of 5 MiB', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });
});

describe('config namespaces — defaults', () => {
  it('videos namespace resolves the documented defaults', () => {
    const config = withEnvUnset(
      [
        'VIDEO_MAX_SIZE_BYTES',
        'VIDEO_UPLOAD_PART_SIZE_BYTES',
        'VIDEO_UPLOAD_URL_TTL_SECONDS',
        'VIDEO_PLAYBACK_URL_TTL_SECONDS',
        'VIDEO_ABANDONED_UPLOAD_HOURS',
        'VIDEO_PROCESSING_STALE_MINUTES',
      ],
      () => videosConfig(),
    );
    expect(config).toEqual({
      maxSizeBytes: 10737418240,
      uploadPartSizeBytes: 67108864,
      uploadUrlTtlSeconds: 3600,
      playbackUrlTtlSeconds: 14400,
      abandonedUploadHours: 24,
      processingStaleMinutes: 60,
    });
  });

  it('storage and queue namespaces resolve their defaults', () => {
    const [storage, queue] = withEnvUnset(
      [
        'S3_ENDPOINT',
        'S3_PUBLIC_ENDPOINT',
        'S3_REGION',
        'S3_BUCKET',
        'QUEUE_HOST',
        'QUEUE_PORT',
        'QUEUE_PREFIX',
      ],
      () => [storageConfig(), queueConfig()] as const,
    );
    expect(storage).toMatchObject({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      bucket: 'streamtube-videos',
    });
    expect(queue).toEqual({ host: 'valkey', port: 6379, prefix: 'bull' });
  });
});

describe('Jest setup-env overrides', () => {
  it('should sign public URLs for the in-network MinIO host and isolate the queue prefix', () => {
    expect(process.env.S3_PUBLIC_ENDPOINT).toBe('http://minio:9000');
    expect(process.env.QUEUE_PREFIX).toBe('bull-test');
  });
});
