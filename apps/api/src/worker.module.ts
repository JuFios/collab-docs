import { Module } from '@nestjs/common';
import { WorkerPlatformModule } from '@collab-docs/shared/nest';
import { MailWorkerModule } from './notifications';

/** Root module of the queue worker process (no HTTP). Stage modules register their processors here. */
@Module({ imports: [WorkerPlatformModule.forRoot(), MailWorkerModule] })
export class WorkerModule {}
