import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { COLLAB_CLOSE, PERM_EVENT_CHANNELS } from '@collab-docs/shared';
import { REDIS_CLIENT, getRootLogger, runWithCorrelationId } from '@collab-docs/shared/nest';
import { AccessReevaluator } from '../access/access-reevaluator.service';
import { RoomManager } from '../rooms/room-manager';

const permChanged = z.object({
  workspaceId: z.string(),
  userId: z.string().optional(),
  documentId: z.string().optional(),
  correlationId: z.string().optional(),
});
const lifecycle = z.object({
  workspaceId: z.string(),
  documentIds: z.array(z.string()),
  correlationId: z.string().optional(),
});

/**
 * Subscribes to the events the api publishes after a commit (`perm.changed`, `doc.deleted`, `doc.restored`)
 * and applies them to the open sockets. The api never waits for this: a lost event is covered by the timer.
 */
@Injectable()
export class PermissionEventsService implements OnModuleInit, OnApplicationShutdown {
  private subscriber: Redis | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AccessReevaluator) private readonly reevaluator: AccessReevaluator,
    @Inject(RoomManager) private readonly rooms: RoomManager,
  ) {}

  async onModuleInit(): Promise<void> {
    const subscriber = this.redis.duplicate();
    this.subscriber = subscriber;
    subscriber.on('error', (error) =>
      getRootLogger().warn({ err: error }, 'permission event subscriber error'),
    );
    subscriber.on('message', (channel, raw) => void this.handle(channel, raw));
    await subscriber.subscribe(...Object.values(PERM_EVENT_CHANNELS));
  }

  async onApplicationShutdown(): Promise<void> {
    const subscriber = this.subscriber;
    if (subscriber && subscriber.status !== 'end') {
      await subscriber.quit().catch(() => subscriber.disconnect());
    }
  }

  /** Public for tests: processes one message as if it had arrived from Redis. */
  async handle(channel: string, raw: string): Promise<void> {
    const log = getRootLogger();
    try {
      const payload: unknown = JSON.parse(raw);
      const correlationId =
        typeof payload === 'object' && payload && 'correlationId' in payload
          ? String((payload as { correlationId: unknown }).correlationId)
          : 'unknown';
      await runWithCorrelationId(correlationId, async () => {
        switch (channel) {
          case PERM_EVENT_CHANNELS.permChanged: {
            const event = permChanged.parse(payload);
            await this.reevaluator.reevaluate({
              workspaceId: event.workspaceId,
              userId: event.userId,
              documentIds: event.documentId ? [event.documentId] : undefined,
            });
            break;
          }
          case PERM_EVENT_CHANNELS.docDeleted: {
            const event = lifecycle.parse(payload);
            await Promise.all(
              event.documentIds.map((id) =>
                this.rooms.closeDocument(id, COLLAB_CLOSE.deleted, 'document deleted', {
                  type: 'deleted',
                }),
              ),
            );
            break;
          }
          case PERM_EVENT_CHANNELS.docRestored: {
            const event = lifecycle.parse(payload);
            await this.reevaluator.reevaluate({ documentIds: event.documentIds });
            break;
          }
        }
      });
    } catch (error) {
      log.warn({ err: error, channel }, 'malformed permission event dropped');
    }
  }
}
