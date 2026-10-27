import { HttpService } from '@nestjs/axios';
import { Processor } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import { MOCK_SIGNATURE_HEADER } from '@collab-docs/shared';
import {
  type AppConfig,
  CORRELATION_HEADER,
  QUEUE_NAMES,
  QueueProcessor,
  getCorrelationId,
  logEvent,
} from '@collab-docs/nest';
import { PrismaService } from '../../prisma/prisma.service';
import { signWebhook } from '../webhook-signature';

const REQUEST_TIMEOUT_MS = 5000;

interface DeliveryJob {
  eventId: string;
}

/**
 * Posts a provider event, signed, to the webhook. Each attempt signs again: the timestamp must be fresh when the
 * receiver checks it, also on the fifth retry. Any answer but 2xx throws, and the queue retries with backoff, which is
 * the at-least-once delivery of a real provider.
 */
@Processor(QUEUE_NAMES.billingDelivery, { concurrency: 5 })
export class MockDeliveryProcessor extends QueueProcessor<DeliveryJob> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly http: HttpService,
  ) {
    super();
  }

  protected async handle(job: Job<DeliveryJob>): Promise<void> {
    const { eventId } = job.data;
    const event = await this.prisma.mockProviderEvent.findUnique({ where: { id: eventId } });
    if (!event) return;

    const body = JSON.stringify(event.payload);
    const url = new URL(
      '/api/billing/webhooks/mock',
      this.config.get('API_INTERNAL_URL', { infer: true }),
    ).href;
    try {
      const response = await firstValueFrom(
        this.http.post(url, body, {
          headers: {
            'Content-Type': 'application/json',
            // the webhook, its job and `plan.changed` continue the correlation of the payment
            ...(getCorrelationId() ? { [CORRELATION_HEADER]: getCorrelationId() } : {}),
            [MOCK_SIGNATURE_HEADER]: signWebhook(
              this.config.get('WEBHOOK_SIGNING_SECRET', { infer: true }),
              body,
            ),
          },
          timeout: REQUEST_TIMEOUT_MS,
        }),
      );
      logEvent(this.logger, 'billing.event_delivered', {
        eventId,
        type: event.type,
        status: response.status,
        attempt: job.attemptsMade + 1,
      });
    } catch (error) {
      this.logger.warn(
        { event: 'billing.delivery_failed', eventId, attempt: job.attemptsMade + 1, err: error },
        'billing.delivery_failed',
      );
      throw error;
    }
  }
}
