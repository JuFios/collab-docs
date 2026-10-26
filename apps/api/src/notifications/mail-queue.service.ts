import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, addJob } from '@collab-docs/nest';
import type { InviteEmailData } from './invite-email';

export const MAIL_JOBS = { invite: 'invite', mention: 'mention' } as const;

export interface InviteMailJob extends InviteEmailData {
  to: string;
}

/** The email is rendered from the notification when the job runs, so it reflects the current state. */
export interface MentionMailJob {
  notificationId: string;
}

export type MailJob = InviteMailJob | MentionMailJob;

/** Producer side of the `mail` queue (retries and backoff come from the queue defaults). */
@Injectable()
export class MailQueueService {
  constructor(@InjectQueue(QUEUE_NAMES.mail) private readonly queue: Queue) {}

  async sendInvite(job: InviteMailJob): Promise<void> {
    await addJob(this.queue, MAIL_JOBS.invite, job);
  }

  /**
   * One job per notification: the id is the notification's own (never reused), so enqueueing it twice leaves one job.
   */
  async sendMention(job: MentionMailJob): Promise<void> {
    await addJob(this.queue, MAIL_JOBS.mention, job, { jobId: `mention-${job.notificationId}` });
  }
}
