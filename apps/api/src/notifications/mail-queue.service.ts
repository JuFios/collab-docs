import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, addJob } from '@collab-docs/nest';
import type { InviteEmailData } from './invite-email';

export const MAIL_JOBS = { invite: 'invite' } as const;

export interface InviteMailJob extends InviteEmailData {
  to: string;
}

/** Producer side of the `mail` queue (retries and backoff come from the queue defaults). */
@Injectable()
export class MailQueueService {
  constructor(@InjectQueue(QUEUE_NAMES.mail) private readonly queue: Queue) {}

  async sendInvite(job: InviteMailJob): Promise<void> {
    await addJob(this.queue, MAIL_JOBS.invite, job);
  }
}
