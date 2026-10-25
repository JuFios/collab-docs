import { Module } from '@nestjs/common';
import { S3Storage } from './s3.service';

@Module({ providers: [S3Storage], exports: [S3Storage] })
export class StorageModule {}
