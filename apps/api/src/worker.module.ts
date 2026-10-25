import { Module } from '@nestjs/common';
import { WorkerPlatformModule } from '@collab-docs/shared/nest';
import { AttachmentsWorkerModule } from './attachments';
import { MailWorkerModule } from './notifications';
import { VersionsWorkerModule } from './versions';

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
