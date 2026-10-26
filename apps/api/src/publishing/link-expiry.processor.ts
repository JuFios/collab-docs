import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES, QueueProcessor, logEvent } from '@collab-docs/nest';
import { PermEventsService } from '../permissions/perm-events.service';
import { PrismaService } from '../prisma/prisma.service';
import type { LinkExpiryJob } from './link-expiry.service';
import { RevalidationService } from './revalidation.service';

/**
 * Runs when a link's expiry passes: logs it, invalidates the cached page of a VIEW link and tells collab to
 * re-read the guests of an EDIT link, so neither waits for its fallback (the 1 h page TTL, the 60 s socket recheck).
 * A job outlives the expiry it was planned for when the link is edited, so it first checks that the link still
 * expires at that moment.
 */
@Processor(QUEUE_NAMES.linkExpiry, { concurrency: 5 })
export class LinkExpiryProcessor extends QueueProcessor<LinkExpiryJob> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly revalidation: RevalidationService,
    private readonly permEvents: PermEventsService,
  ) {
    super();
  }

  protected async handle(job: Job<LinkExpiryJob>): Promise<void> {
    const link = await this.prisma.publicLink.findUnique({
      where: { id: job.data.linkId },
      include: { document: { select: { workspaceId: true } } },
    });
    if (
      !link ||
      link.revokedAt ||
      link.expiresAt?.toISOString() !== job.data.expiresAt ||
      link.expiresAt.getTime() > Date.now()
    ) {
      return; // revoked, deleted, replaced or moved to another time since
    }
    logEvent(this.logger, 'public_link.expired', {
      linkId: link.id,
      documentId: link.documentId,
      mode: link.mode,
    });
    if (link.mode === 'VIEW') {
      await this.revalidation.enqueue(link.documentId, 'expiry');
    } else {
      await this.permEvents.permChanged({
        workspaceId: link.document.workspaceId,
        documentId: link.documentId,
        reason: 'link_changed',
      });
    }
  }
}
