import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { type Observable, Subject, filter } from 'rxjs';
import {
  REALTIME_CHANNEL,
  type RealtimeEnvelope,
  type TreeChangedEvent,
  type UserRealtimeEvent,
} from '@collab-docs/shared';
import { REDIS_CLIENT, getRootLogger } from '@collab-docs/shared/nest';

/**
 * Redis pub/sub bridge for server-sent events. Publishers (any api instance) write to one channel; every
 * instance holds one subscriber connection, opened on the first stream, and fans messages out in-process.
 */
@Injectable()
export class RealtimeEventsService implements OnApplicationShutdown {
  private readonly messages = new Subject<RealtimeEnvelope>();
  private subscriber: Redis | null = null;
  private subscribing: Promise<void> | null = null;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Publishes after commit; losing a message only delays a refetch, so failures are logged. */
  async publish(envelope: RealtimeEnvelope): Promise<void> {
    try {
      await this.redis.publish(REALTIME_CHANNEL, JSON.stringify(envelope));
    } catch (error) {
      getRootLogger().warn({ err: error }, 'realtime publish failed');
    }
  }

  publishTreeChanged(event: Omit<TreeChangedEvent, 'type'>): Promise<void> {
    return this.publish({
      scope: 'workspace',
      workspaceId: event.workspaceId,
      event: { type: 'tree.changed', ...event },
    });
  }

  publishToUser(userId: string, event: UserRealtimeEvent): Promise<void> {
    return this.publish({ scope: 'user', userId, event });
  }

  /** Events for one workspace plus the user's personal events. Resolves once the Redis subscription is live. */
  async stream(workspaceId: string, userId: string): Promise<Observable<RealtimeEnvelope>> {
    await this.ensureSubscribed();
    return this.messages.pipe(
      filter((m) =>
        m.scope === 'workspace' ? m.workspaceId === workspaceId : m.userId === userId,
      ),
    );
  }

  private ensureSubscribed(): Promise<void> {
    this.subscribing ??= this.subscribe().catch((error) => {
      this.subscribing = null;
      throw error;
    });
    return this.subscribing;
  }

  private async subscribe(): Promise<void> {
    const subscriber = this.redis.duplicate();
    subscriber.on('message', (_channel, raw) => {
      try {
        this.messages.next(JSON.parse(raw) as RealtimeEnvelope);
      } catch (error) {
        getRootLogger().warn({ err: error }, 'malformed realtime message dropped');
      }
    });
    subscriber.on('error', (error) =>
      getRootLogger().warn({ err: error }, 'realtime subscriber error'),
    );
    this.subscriber = subscriber;
    await subscriber.subscribe(REALTIME_CHANNEL);
  }

  async onApplicationShutdown(): Promise<void> {
    this.messages.complete();
    if (this.subscriber && this.subscriber.status !== 'end') {
      await this.subscriber.quit().catch(() => this.subscriber?.disconnect());
    }
  }
}
