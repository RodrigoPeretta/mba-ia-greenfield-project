import { S3Client } from '@aws-sdk/client-s3';
import type { Provider } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';

const createS3Client = (
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

/** Server-side operations: reaches the storage through the Compose service name. */
export const s3InternalClientProvider: Provider = {
  provide: S3_INTERNAL_CLIENT,
  inject: [storageConfig.KEY],
  useFactory: (config: ConfigType<typeof storageConfig>) =>
    createS3Client(config, config.endpoint),
};

/** Signing only: URLs handed to the browser must carry the public host. */
export const s3PublicClientProvider: Provider = {
  provide: S3_PUBLIC_CLIENT,
  inject: [storageConfig.KEY],
  useFactory: (config: ConfigType<typeof storageConfig>) =>
    createS3Client(config, config.publicEndpoint),
};
