import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PERM_EVENT_CHANNELS, type PermChangedEvent } from '@collab-docs/shared';
import { REDIS_CLIENT, getCorrelationId, getRootLogger } from '@collab-docs/shared/nest';

/**
 * Publishes permission events to Redis. Call it only after the database transaction has committed:
 * collab re-reads the permissions when the event arrives. A lost message is harmless (collab re-evaluates
 * every socket every 60 s), so failures are logged and never fail the request.
 */
@Injectable()
export class PermEventsService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async permChanged(event: PermChangedEvent): Promise<void> {
    try {
      await this.redis.publish(
        PERM_EVENT_CHANNELS.permChanged,
        JSON.stringify({ ...event, correlationId: getCorrelationId() }),
      );
    } catch (error) {
      getRootLogger().warn({ err: error, event }, 'perm.changed publish failed');
    }
  }
}
