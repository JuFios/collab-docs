import { Module } from '@nestjs/common';
import { WorkerPlatformModule } from '@collab-docs/nest';
import { AttachmentsWorkerModule } from './attachments/attachments.module';
import { BillingWorkerModule } from './billing/billing.module';
import { MailWorkerModule } from './mail/mail.module';
import { PublishingWorkerModule } from './publishing/publishing.module';
import { SearchWorkerModule } from './search/search.module';
import { VersionsWorkerModule } from './versions/versions.module';

/** Root module of the queue worker process (no HTTP). Stage modules register their processors here. */
@Module({
  imports: [
    WorkerPlatformModule.forRoot(),
    MailWorkerModule,
    VersionsWorkerModule,
    AttachmentsWorkerModule,
    PublishingWorkerModule,
    SearchWorkerModule,
    BillingWorkerModule,
  ],
})
export class WorkerModule {}
