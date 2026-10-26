import { Module } from '@nestjs/common';
import { MailProcessor } from './mail.processor';
import { MailQueueService } from './mail-queue.service';
import { MailerService } from './mailer.service';
import { MentionMailService } from './mention-mail.service';
import { PrismaModule } from '../prisma/prisma.module';

/** Enqueues emails (used by the api process) and renders the ones that depend on stored data. */
@Module({
  imports: [PrismaModule],
  providers: [MailerService, MailQueueService, MentionMailService],
  exports: [MailerService, MailQueueService, MentionMailService],
})
export class NotificationsModule {}

/** Registers the `mail` queue processor; imported by the worker process only. */
@Module({ imports: [NotificationsModule], providers: [MailProcessor] })
export class MailWorkerModule {}
