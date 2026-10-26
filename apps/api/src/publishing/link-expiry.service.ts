import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES, QueueService } from '@collab-docs/nest';

interface ExpiringLink {
  id: string;
  expiresAt: Date | null;
}

/** One delayed job per (link, expiry): moving the expiry gives the new job a new id. */
export const expiryJobId = (link: { id: string; expiresAt: Date }): string =>
  `link-expiry-${link.id}-${link.expiresAt.getTime()}`;

export interface LinkExpiryJob {
  linkId: string;
  /** ISO time the job was planned for; a job whose link has a different expiry now is stale. */
  expiresAt: string;
}

/** Plans the moment a link stops working, so the cached page and the guests' sockets do not wait for a timer. */
@Injectable()
export class LinkExpiryService {
  constructor(private readonly queues: QueueService) {}

  /** Replaces the job of `before` with one for `after`; a failure is logged, the hourly TTL and the 60 s recheck still apply. */
  async reschedule(before: ExpiringLink | null, after: ExpiringLink | null): Promise<void> {
    try {
      if (before?.expiresAt) {
        const job = await this.queues
          .getQueue(QUEUE_NAMES.linkExpiry)
          .getJob(expiryJobId({ id: before.id, expiresAt: before.expiresAt }));
        // an active or finished job cannot be removed; the processor ignores it when it is stale
        await job?.remove().catch(() => undefined);
      }
      if (after?.expiresAt) {
        const data: LinkExpiryJob = { linkId: after.id, expiresAt: after.expiresAt.toISOString() };
        await this.queues.add(QUEUE_NAMES.linkExpiry, 'expire', data, {
          delay: Math.max(0, after.expiresAt.getTime() - Date.now()),
          jobId: expiryJobId({ id: after.id, expiresAt: after.expiresAt }),
        });
      }
    } catch (error) {
      this.queues.recordEnqueueFailure(
        QUEUE_NAMES.linkExpiry,
        'public_link.expiry_enqueue_failed',
        {
          linkId: after?.id ?? before?.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}
