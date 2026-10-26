import { Injectable, type OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES, QueueService } from '@collab-docs/nest';
import { renderInviteEmail } from './invite-email';
import { MAIL_JOBS, type InviteMailJob } from './mail-queue.service';
import { MailerService } from './mailer.service';

/** Consumes the `mail` queue in the worker process. A thrown error makes BullMQ retry with backoff. */
@Injectable()
export class MailProcessor implements OnModuleInit {
  constructor(
    private readonly queues: QueueService,
    private readonly mailer: MailerService,
  ) {}

  onModuleInit(): void {
    this.queues.process<InviteMailJob>(QUEUE_NAMES.mail, async (job) => {
      if (job.name !== MAIL_JOBS.invite) return;
      const { to, ...data } = job.data;
      await this.mailer.send({ to, ...renderInviteEmail(data) });
    });
  }
}
