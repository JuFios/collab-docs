import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { CollabModule } from '../collab/collab.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { VersionsModule } from '../versions/versions.module';
import { LinkExpiryProcessor } from './link-expiry.processor';
import { LinkExpiryService } from './link-expiry.service';
import { PublicLinksController } from './public-links.controller';
import { PublicLinksService } from './public-links.service';
import { PublicRevalidateProcessor } from './public-revalidate.processor';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';
import { RevalidationModule } from './revalidation.module';

@Module({
  imports: [CollabModule, PermissionsModule, RevalidationModule, StorageModule, VersionsModule],
  controllers: [PublicLinksController, PublicController],
  providers: [PublicLinksService, PublicService, LinkExpiryService],
})
export class PublishingModule {}

/** The queue processors of publishing; imported by the worker process only. */
@Module({
  imports: [HttpModule, PrismaModule, PermissionsModule, RevalidationModule],
  providers: [PublicRevalidateProcessor, LinkExpiryProcessor],
})
export class PublishingWorkerModule {}
