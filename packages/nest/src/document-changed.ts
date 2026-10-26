import type { DocumentChangedEvent } from '@collab-docs/shared';
import { QUEUE_NAMES, type QueueService, enqueueDebounced } from './queue';

/** Debounce windows (spec §7a, env): page revalidation 3 s, search indexing 5 s by default. */
export const DOCUMENT_CHANGED_TARGETS = [
  { queue: QUEUE_NAMES.publicRevalidate, debounce: 'REVALIDATE_DEBOUNCE_MS' },
  { queue: QUEUE_NAMES.searchSync, debounce: 'SEARCH_DEBOUNCE_MS' },
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
    DOCUMENT_CHANGED_TARGETS.map(async ({ queue, debounce }) => {
      try {
        await enqueueDebounced(queues.getQueue(queue), event.documentId, queues.setting(debounce), {
          revision: event.revision,
          reason: event.reason,
        });
      } catch (error) {
        queues.recordEnqueueFailure(queue, 'document.changed_enqueue_failed', {
          documentId: event.documentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
}
