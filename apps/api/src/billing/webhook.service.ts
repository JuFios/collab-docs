import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Counter } from 'prom-client';
import type { Prisma } from '@collab-docs/db';
import { billingEventSchema } from '@collab-docs/shared';
import {
  type AppConfig,
  AppException,
  InjectPinoLogger,
  MetricsService,
  PinoLogger,
  QUEUE_NAMES,
  QueueService,
  logEvent,
} from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { verifyWebhook } from './webhook-signature';

export type WebhookAck = { received: true } | { duplicate: true };

/**
 * Receiving end of the provider's deliveries (spec §8). The event is stored before it is queued, and a repeated
 * delivery of an event that was never processed queues it again: a queue that was down at the first delivery
 * loses nothing, and the provider's retry repairs it.
 */
@Injectable()
export class WebhookService {
  private readonly deliveries: Counter<'result'>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly config: ConfigService<AppConfig, true>,
    metrics: MetricsService,
    @InjectPinoLogger(WebhookService.name) private readonly logger: PinoLogger,
  ) {
    this.deliveries = new Counter({
      name: 'billing_webhook_deliveries_total',
      help: 'Webhook deliveries by result (new, requeued, duplicate, rejected)',
      labelNames: ['result'],
      registers: [metrics.registry],
    });
  }

  async receive(rawBody: Buffer | undefined, signature: string | undefined): Promise<WebhookAck> {
    const verdict = rawBody
      ? verifyWebhook({
          secret: this.config.get('WEBHOOK_SIGNING_SECRET', { infer: true }),
          body: rawBody,
          header: signature,
        })
      : 'malformed';
    if (verdict !== 'valid' || !rawBody) {
      this.deliveries.inc({ result: 'rejected' });
      logEvent(this.logger, 'webhook.signature_rejected', { reason: verdict });
      throw new AppException('WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature');
    }

    const json = parseJson(rawBody);
    const event = billingEventSchema.safeParse(json);
    if (!event.success) throw new AppException('BAD_REQUEST', 'Malformed webhook event');
    const { id: eventId, type } = event.data;

    const inserted = await this.prisma.webhookEvent.createMany({
      data: [{ eventId, type, payload: json as Prisma.InputJsonObject }],
      skipDuplicates: true,
    });
    if (inserted.count === 1) {
      await this.enqueue(eventId);
      this.deliveries.inc({ result: 'new' });
      return { received: true };
    }

    const stored = await this.prisma.webhookEvent.findUnique({
      where: { eventId },
      select: { status: true },
    });
    if (stored?.status === 'PROCESSED') {
      this.deliveries.inc({ result: 'duplicate' });
      logEvent(this.logger, 'webhook.duplicate_delivery', { eventId, type });
      return { duplicate: true };
    }
    // RECEIVED: the first delivery stored it but its job is missing (queue was unavailable) or failed for good
    await this.enqueue(eventId);
    this.deliveries.inc({ result: 'requeued' });
    logEvent(this.logger, 'webhook.requeued', { eventId, type });
    return { received: true };
  }

  /**
   * Queues the event once (`jobId = eventId`). BullMQ ignores `add` for an id it still remembers, so a job that
   * exhausted its attempts is retried instead. A queue that cannot take the job fails the delivery with 503: the
   * provider delivers again.
   */
  private async enqueue(eventId: string): Promise<void> {
    try {
      const existing = await this.queues.getQueue(QUEUE_NAMES.billingWebhook).getJob(eventId);
      if (existing && (await existing.isFailed())) {
        await existing.retry('failed');
        return;
      }
      await this.queues.add(QUEUE_NAMES.billingWebhook, 'process', { eventId }, { jobId: eventId });
    } catch (error) {
      this.queues.recordEnqueueFailure(QUEUE_NAMES.billingWebhook, 'webhook.enqueue_failed', {
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AppException(
        'SERVICE_UNAVAILABLE',
        'Event stored but not queued, deliver it again',
      );
    }
  }
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}
