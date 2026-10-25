import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { DocumentVersions } from '@collab-docs/db';
import { QUEUE_NAMES, QueueService, logEvent } from '@collab-docs/shared/nest';

const PRUNE_EVERY_MS = 60 * 60 * 1000;
const SCHEDULER_ID = 'version-prune-hourly';

/** Applies the retention policy (50 automatic snapshots per document, 100 snapshots in all) once an hour. */
@Injectable()
export class VersionPruneProcessor implements OnModuleInit {
  constructor(
    @Inject(QueueService) private readonly queues: QueueService,
    @Inject(DocumentVersions) private readonly versions: DocumentVersions,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queues.process(QUEUE_NAMES.versionPrune, async () => {
      const deleted = await this.versions.prune();
      logEvent('versions.pruned', { deleted });
    });
    // idempotent: every worker start upserts the same scheduler instead of stacking repeat jobs
    await this.queues
      .getQueue(QUEUE_NAMES.versionPrune)
      .upsertJobScheduler(SCHEDULER_ID, { every: PRUNE_EVERY_MS }, { name: 'prune' });
  }
}
