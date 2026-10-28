import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type JobEnvelope, QUEUE_NAMES, QueueProcessor } from '@collab-docs/nest';
import { renderInviteEmail } from './invite-email';
import {
  MAIL_JOBS,
  type InviteMailJob,
  type MailJob,
  type MentionMailJob,
} from './mail-queue.service';
import { MailerService } from './mailer.service';
import { MentionMailService } from './mention-mail.service';

/** Consumes the `mail` queue in the worker process. A thrown error makes BullMQ retry with backoff. */
@Processor(QUEUE_NAMES.mail, { concurrency: 5 })
export class MailProcessor extends QueueProcessor<MailJob> {
  constructor(
    private readonly mailer: MailerService,
    private readonly mentions: MentionMailService,
  ) {
    super();
  }

  protected async handle(job: Job<MailJob & JobEnvelope>): Promise<void> {
    switch (job.name) {
      case MAIL_JOBS.invite: {
        const { to, ...data } = job.data as InviteMailJob;
        await this.mailer.send({ to, ...renderInviteEmail(data) });
        return;
      }
      case MAIL_JOBS.mention:
        await this.mentions.deliver((job.data as MentionMailJob).notificationId);
        return;
      default:
        return;
    }
  }
}
