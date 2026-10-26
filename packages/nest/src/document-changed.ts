import type { DocumentChangedEvent } from '@collab-docs/shared';
import { logEvent } from './logger';
import { QUEUE_NAMES, type QueueService, enqueueDebounced } from './queue';

/** Debounce windows (spec §7a): page revalidation 3 s, search indexing 5 s. */
export const DOCUMENT_CHANGED_TARGETS = [
  { queue: QUEUE_NAMES.publicRevalidate, delayMs: 3000 },
  { queue: QUEUE_NAMES.searchSync, delayMs: 5000 },
] as const;

/**
 * Announces `document.changed` to the derived-data queues. Call it after the transaction that bumped
 * `documents.revision` has committed. A failed enqueue is logged and counted but never thrown: editing must not
 * depend on the search index or the public page cache.
 */
export async function emitDocumentChanged(
  queues: QueueService,
  event: DocumentChangedEvent,
): Promise<void> {
  await Promise.all(
    DOCUMENT_CHANGED_TARGETS.map(async ({ queue, delayMs }) => {
      try {
        await enqueueDebounced(queues.getQueue(queue), event.documentId, delayMs, {
          revision: event.revision,
          reason: event.reason,
        });
      } catch (error) {
        queues.enqueueFailures.inc({ queue });
        logEvent('document.changed_enqueue_failed', {
          queue,
          documentId: event.documentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}
