import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES, QueueService } from '@collab-docs/nest';

/** Why a page has to be rebuilt although the content did not change. */
type RevalidationReason = 'publish' | 'unpublish' | 'expiry';

/**
 * Asks the `public-revalidate` queue to invalidate the cached page of a document. Content, title, delete and
 * restore go through `emitDocumentChanged` (debounced); the link lifecycle goes through here and is not
 * debounced: an unpublished page must stop being served as soon as possible, and a page published right
 * after a visit that cached the 404 must appear. Never called from the editing path.
 */
@Injectable()
export class RevalidationService {
  constructor(private readonly queues: QueueService) {}

  /** Throws when the job cannot be queued (used by processors, which are retried). */
  enqueue(documentId: string, reason: RevalidationReason): Promise<unknown> {
    return this.queues.add(QUEUE_NAMES.publicRevalidate, 'process', { documentId, reason });
  }

  /** For requests: a failed enqueue is logged and counted, the page then falls back to its 1 h TTL. */
  async request(documentId: string, reason: RevalidationReason): Promise<void> {
    try {
      await this.enqueue(documentId, reason);
    } catch (error) {
      this.queues.recordEnqueueFailure(
        QUEUE_NAMES.publicRevalidate,
        'public_revalidate.enqueue_failed',
        { documentId, reason, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }
}
