import { Module } from '@nestjs/common';
import { RevalidationService } from './revalidation.service';

/** The one provider of `RevalidationService`, imported by the api and by the worker process. */
@Module({
  providers: [RevalidationService],
  exports: [RevalidationService],
})
export class RevalidationModule {}
