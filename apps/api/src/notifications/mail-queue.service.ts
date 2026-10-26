import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES, QueueService } from '@collab-docs/nest';
import type { InviteEmailData } from './invite-email';

export const MAIL_JOBS = { invite: 'invite' } as const;

export interface InviteMailJob extends InviteEmailData {
  to: string;
}

/** Producer side of the `mail` queue (retries and backoff come from the queue defaults). */
@Injectable()
export class MailQueueService {
  constructor(private readonly queues: QueueService) {}

  async sendInvite(job: InviteMailJob): Promise<void> {
    await this.queues.add(QUEUE_NAMES.mail, MAIL_JOBS.invite, job);
  }
}
