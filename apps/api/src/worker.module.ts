import { Module } from '@nestjs/common';
import { WorkerPlatformModule } from '@collab-docs/nest';
import { AttachmentsWorkerModule } from './attachments/attachments.module';
import { MailWorkerModule } from './notifications/notifications.module';
import { VersionsWorkerModule } from './versions/versions.module';

/** Root module of the queue worker process (no HTTP). Stage modules register their processors here. */
@Module({
  imports: [
    WorkerPlatformModule.forRoot(),
    MailWorkerModule,
    VersionsWorkerModule,
    AttachmentsWorkerModule,
  ],
})
export class WorkerModule {}
