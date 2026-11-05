import { Module } from '@nestjs/common';
import {
  s3InternalClientProvider,
  s3PublicClientProvider,
} from './s3-clients.provider';
import { StorageService } from './storage.service';

@Module({
  providers: [s3InternalClientProvider, s3PublicClientProvider, StorageService],
  exports: [StorageService],
})
export class StorageModule {}
