import { Module } from '@nestjs/common';
import { WorkerPlatformModule } from '@collab-docs/shared/nest';

/** Root module of the queue worker process (no HTTP). Stage modules register their processors here. */
@Module({ imports: [WorkerPlatformModule.forRoot()] })
export class WorkerModule {}
