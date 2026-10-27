import { Processor } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES, QueueProcessor } from '@collab-docs/nest';
import { BillingEventsService } from './billing-events.service';

interface BillingWebhookJob {
  eventId: string;
}

/**
 * Applies a received webhook event (`jobId = eventId`, so a queued event is queued once). A thrown error makes the
 * queue retry with backoff; every outcome of `process` (applied, ignored, already processed) is a finished job.
 */
@Processor(QUEUE_NAMES.billingWebhook, { concurrency: 5 })
export class BillingEventsProcessor extends QueueProcessor<BillingWebhookJob> {
  constructor(private readonly events: BillingEventsService) {
    super();
  }

  protected async handle(job: Job<BillingWebhookJob>): Promise<void> {
    await this.events.process(job.data.eventId);
  }
}
