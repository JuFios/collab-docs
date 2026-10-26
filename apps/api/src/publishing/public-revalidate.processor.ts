import { Processor } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { publicPageTag } from '@collab-docs/shared';
import { type AppConfig, QUEUE_NAMES, QueueProcessor, logEvent } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';

/** The web app answers within milliseconds; anything slower is retried by the queue. */
const REQUEST_TIMEOUT_MS = 5000;

interface RevalidateJob {
  documentId: string;
  revision?: number;
  reason?: string;
}

/**
 * Tells the web app to drop the cached page of a document (`POST {WEB_INTERNAL_URL}/internal/revalidate`). The job
 * is queued with a debounce, so a burst of edits becomes one call. It looks at the page of the document when it
 * runs, not when it was queued: whatever the slug is by then is the one to invalidate. A document that was ever
 * published qualifies, not only one with a live link, because the last thing to invalidate after an unpublish,
 * an expiry or a delete is a page that is no longer allowed to be served. A failure throws, and the queue retries
 * with backoff; after the last attempt the page falls back to its TTL.
 */
@Processor(QUEUE_NAMES.publicRevalidate, { concurrency: 5 })
export class PublicRevalidateProcessor extends QueueProcessor<RevalidateJob> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {
    super();
  }

  protected async handle(job: Job<RevalidateJob>): Promise<void> {
    const { documentId, reason } = job.data;
    const link = await this.prisma.publicLink.findUnique({
      where: { documentId_mode: { documentId, mode: 'VIEW' } },
      select: { slug: true },
    });
    if (!link?.slug) return;

    const startedAt = Date.now();
    try {
      const response = await fetch(
        new URL('/internal/revalidate', this.config.get('WEB_INTERNAL_URL', { infer: true })),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-revalidate-secret': this.config.get('REVALIDATE_SECRET', { infer: true }),
          },
          body: JSON.stringify({ tags: [publicPageTag(link.slug)] }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`the web app answered ${response.status}`);
      logEvent(this.logger, 'revalidate.sent', {
        documentId,
        slug: link.slug,
        reason,
        attempt: job.attemptsMade + 1,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.logger.warn(
        {
          event: 'revalidate.failed',
          documentId,
          slug: link.slug,
          reason,
          attempt: job.attemptsMade + 1,
          err: error,
        },
        'revalidate.failed',
      );
      throw error;
    }
  }
}
