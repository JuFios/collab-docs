import { HttpService } from '@nestjs/axios';
import { Processor } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { publicPageTag } from '@collab-docs/shared';
import { type AppConfig, QUEUE_NAMES, QueueProcessor, logEvent } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { statusOf } from './link-status';

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
 *
 * Next writes a page to its cache after it has answered, so a visit that is rendered just before the invalidation can
 * store the old page after it and make it look fresh again. For a page that must stop being served (unpublished,
 * expired, deleted) the job therefore looks at what the web app answers, and fails, to be retried, while it is not a 404;
 * the same for a page that has just been published after a visit that cached the 404, which has to answer 200.
 */
@Processor(QUEUE_NAMES.publicRevalidate, { concurrency: 5 })
export class PublicRevalidateProcessor extends QueueProcessor<RevalidateJob> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly http: HttpService,
  ) {
    super();
  }

  protected async handle(job: Job<RevalidateJob>): Promise<void> {
    const { documentId, reason } = job.data;
    const link = await this.prisma.publicLink.findUnique({
      where: { documentId_mode: { documentId, mode: 'VIEW' } },
      select: {
        slug: true,
        revokedAt: true,
        expiresAt: true,
        document: { select: { deletedAt: true } },
      },
    });
    if (!link?.slug) return;
    const mustBeGone = statusOf(link) !== 'active' || link.document.deletedAt !== null;
    const expectedStatus = mustBeGone ? 404 : reason === 'publish' ? 200 : undefined;

    const startedAt = Date.now();
    try {
      await firstValueFrom(
        this.http.post(
          new URL('/internal/revalidate', this.config.get('WEB_INTERNAL_URL', { infer: true }))
            .href,
          { tags: [publicPageTag(link.slug)] },
          {
            headers: {
              'x-revalidate-secret': this.config.get('REVALIDATE_SECRET', { infer: true }),
            },
            timeout: REQUEST_TIMEOUT_MS,
          },
        ),
      );
      if (expectedStatus) await this.assertServes(link.slug, expectedStatus);
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

  /** The page of `slug` has to answer `expected` now; anything else means the old page is still in the cache. */
  private async assertServes(slug: string, expected: number): Promise<void> {
    const response = await firstValueFrom(
      this.http.get(
        new URL(
          `/p/${encodeURIComponent(slug)}`,
          this.config.get('WEB_INTERNAL_URL', { infer: true }),
        ).href,
        { timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true, responseType: 'text' },
      ),
    );
    if (response.status !== expected) {
      throw new Error(
        `The page answers ${response.status} after its invalidation, expected ${expected}`,
      );
    }
  }
}
