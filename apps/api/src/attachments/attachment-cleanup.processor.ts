import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES, QueueService } from '@collab-docs/nest';
import { AttachmentSweeper } from './attachment-sweeper';

const SWEEP_EVERY_MS = 60 * 60 * 1000;
const SCHEDULER_ID = 'attachment-cleanup-hourly';

/** Runs the sweep of abandoned uploads once an hour. */
@Injectable()
export class AttachmentCleanupProcessor implements OnModuleInit {
  constructor(
    @Inject(QueueService) private readonly queues: QueueService,
    @Inject(AttachmentSweeper) private readonly sweeper: AttachmentSweeper,
  ) {}

  async onModuleInit(): Promise<void> {
    this.queues.process(QUEUE_NAMES.attachmentCleanup, async () => {
      await this.sweeper.sweep();
    });
    await this.queues
      .getQueue(QUEUE_NAMES.attachmentCleanup)
      .upsertJobScheduler(SCHEDULER_ID, { every: SWEEP_EVERY_MS }, { name: 'sweep' });
  }
}
