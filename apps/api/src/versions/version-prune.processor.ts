import { InjectQueue, Processor } from '@nestjs/bullmq';
import { type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DocumentVersions } from '@collab-docs/db';
import { QUEUE_NAMES, QueueProcessor, logEvent } from '@collab-docs/nest';

const PRUNE_EVERY_MS = 60 * 60 * 1000;
const SCHEDULER_ID = 'version-prune-hourly';

/** Applies the retention policy (50 automatic snapshots per document, 100 snapshots in all) once an hour. */
@Processor(QUEUE_NAMES.versionPrune, { concurrency: 5 })
export class VersionPruneProcessor extends QueueProcessor implements OnModuleInit {
  constructor(
    @InjectQueue(QUEUE_NAMES.versionPrune) private readonly queue: Queue,
    private readonly versions: DocumentVersions,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // idempotent: every worker start upserts the same scheduler instead of stacking repeat jobs
    await this.queue.upsertJobScheduler(SCHEDULER_ID, { every: PRUNE_EVERY_MS }, { name: 'prune' });
  }

  protected async handle(): Promise<void> {
    const deleted = await this.versions.prune();
    logEvent(this.logger, 'versions.pruned', { deleted });
  }
}
