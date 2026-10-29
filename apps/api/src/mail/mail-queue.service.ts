import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, addJob } from '@collab-docs/nest';
import type { InviteEmailData } from './invite-email';
import type { VerifyEmailData } from './verify-email';

export const MAIL_JOBS = {
  invite: 'invite',
  mention: 'mention',
  verifyEmail: 'verify-email',
} as const;

export interface InviteMailJob extends InviteEmailData {
  to: string;
}

export interface VerifyEmailMailJob extends VerifyEmailData {
  to: string;
}

/** The email is rendered from the notification when the job runs, so it reflects the current state. */
export interface MentionMailJob {
  notificationId: string;
}

export type MailJob = InviteMailJob | MentionMailJob | VerifyEmailMailJob;

/** Producer side of the `mail` queue (retries and backoff come from the queue defaults). */
@Injectable()
export class MailQueueService {
  constructor(@InjectQueue(QUEUE_NAMES.mail) private readonly queue: Queue) {}

  async sendInvite(job: InviteMailJob): Promise<void> {
    await addJob(this.queue, MAIL_JOBS.invite, job);
  }

  async sendVerifyEmail(job: VerifyEmailMailJob): Promise<void> {
    await addJob(this.queue, MAIL_JOBS.verifyEmail, job);
  }

  /**
   * One job per notification: the id is the notification's own (never reused), so enqueueing it twice leaves one job.
   */
  async sendMention(job: MentionMailJob): Promise<void> {
    await addJob(this.queue, MAIL_JOBS.mention, job, { jobId: `mention-${job.notificationId}` });
  }
}
