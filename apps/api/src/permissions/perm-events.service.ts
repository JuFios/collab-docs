import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  type DocLifecycleEvent,
  PERM_EVENT_CHANNELS,
  type PermChangedEvent,
} from '@collab-docs/shared';
import { REDIS_CLIENT, getCorrelationId, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';

/**
 * Publishes permission events to Redis. Call it only after the database transaction has committed:
 * collab re-reads the permissions when the event arrives. A lost message is harmless (collab re-evaluates
 * every socket every 60 s), so failures are logged and never fail the request.
 */
@Injectable()
export class PermEventsService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectPinoLogger(PermEventsService.name) private readonly logger: PinoLogger,
  ) {}

  async permChanged(event: PermChangedEvent): Promise<void> {
    try {
      await this.redis.publish(
        PERM_EVENT_CHANNELS.permChanged,
        JSON.stringify({ ...event, correlationId: getCorrelationId() }),
      );
    } catch (error) {
      this.logger.warn({ err: error, event }, 'perm.changed publish failed');
    }
  }

  async docDeleted(event: DocLifecycleEvent): Promise<void> {
    await this.publish(PERM_EVENT_CHANNELS.docDeleted, event);
  }

  async docRestored(event: DocLifecycleEvent): Promise<void> {
    await this.publish(PERM_EVENT_CHANNELS.docRestored, event);
  }

  private async publish(channel: string, event: DocLifecycleEvent): Promise<void> {
    try {
      await this.redis.publish(
        channel,
        JSON.stringify({ ...event, correlationId: getCorrelationId() }),
      );
    } catch (error) {
      this.logger.warn(
        { err: error, channel, workspaceId: event.workspaceId },
        `${channel} publish failed`,
      );
    }
  }
}
