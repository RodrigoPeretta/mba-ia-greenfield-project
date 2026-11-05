import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoUploadsService } from './video-uploads.service';
import { VideosController } from './videos.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule, ChannelsModule],
  controllers: [VideosController],
  providers: [VideoUploadsService],
})
export class VideosModule {}
