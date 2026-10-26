import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type JobEnvelope, QUEUE_NAMES, QueueProcessor } from '@collab-docs/nest';
import { renderInviteEmail } from './invite-email';
import { MAIL_JOBS, type InviteMailJob } from './mail-queue.service';
import { MailerService } from './mailer.service';

/** Consumes the `mail` queue in the worker process. A thrown error makes BullMQ retry with backoff. */
@Processor(QUEUE_NAMES.mail, { concurrency: 5 })
export class MailProcessor extends QueueProcessor<InviteMailJob> {
  constructor(private readonly mailer: MailerService) {
    super();
  }

  protected async handle(job: Job<InviteMailJob & JobEnvelope>): Promise<void> {
    if (job.name !== MAIL_JOBS.invite) return;
    const { to, ...data } = job.data;
    await this.mailer.send({ to, ...renderInviteEmail(data) });
  }
}
