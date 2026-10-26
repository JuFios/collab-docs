import { InjectQueue, Processor } from '@nestjs/bullmq';
import { type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAMES, QueueProcessor } from '@collab-docs/nest';
import { AttachmentSweeper } from './attachment-sweeper';

const SWEEP_EVERY_MS = 60 * 60 * 1000;
const SCHEDULER_ID = 'attachment-cleanup-hourly';

/** Runs the sweep of abandoned uploads once an hour. */
@Processor(QUEUE_NAMES.attachmentCleanup, { concurrency: 5 })
export class AttachmentCleanupProcessor extends QueueProcessor implements OnModuleInit {
  constructor(
    @InjectQueue(QUEUE_NAMES.attachmentCleanup) private readonly queue: Queue,
    private readonly sweeper: AttachmentSweeper,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(SCHEDULER_ID, { every: SWEEP_EVERY_MS }, { name: 'sweep' });
  }

  protected async handle(): Promise<void> {
    await this.sweeper.sweep();
  }
}
