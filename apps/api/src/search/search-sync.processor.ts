import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES, QueueProcessor } from '@collab-docs/nest';
import { SearchIndexService } from './search-index.service';

interface SearchSyncJob {
  documentId: string;
  revision?: number;
  reason?: string;
}

/**
 * Consumer of `document.changed` for the search index. The job is queued with a debounce (`SEARCH_DEBOUNCE_MS`), so
 * a burst of edits is one run; it indexes what is stored when it runs, not what the event announced. A thrown error
 * makes the queue retry with backoff.
 */
@Processor(QUEUE_NAMES.searchSync, { concurrency: 5 })
export class SearchSyncProcessor extends QueueProcessor<SearchSyncJob> {
  constructor(private readonly index: SearchIndexService) {
    super();
  }

  protected async handle(job: Job<SearchSyncJob>): Promise<void> {
    await this.index.index(job.data.documentId);
  }
}
