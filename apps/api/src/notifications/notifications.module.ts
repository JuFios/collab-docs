import { Module } from '@nestjs/common';
import { MailProcessor } from './mail.processor';
import { MailQueueService } from './mail-queue.service';
import { MailerService } from './mailer.service';

/** Enqueues emails (used by the api process). */
@Module({
  providers: [MailerService, MailQueueService],
  exports: [MailerService, MailQueueService],
})
export class NotificationsModule {}

/** Registers the `mail` queue processor; imported by the worker process only. */
@Module({ imports: [NotificationsModule], providers: [MailProcessor] })
export class MailWorkerModule {}
