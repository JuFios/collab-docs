import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { COLLAB_CLOSE } from '@collab-docs/shared';
import { type AppConfig, getRootLogger } from '@collab-docs/nest';
import { CollabMetrics } from '../metrics/collab-metrics.service';
import { type Session, RoomManager } from '../rooms/room-manager';
import { AccessService } from './access.service';

const BATCH_SIZE = 25;

/**
 * Applies changed permissions to open sockets: read-only on a downgrade, upgraded again on a grant, closed
 * (4403/4404/4410) when access is gone. Triggered by Redis events and by a timer that is the safety net for
 * lost events and the only thing that notices an expired guest link.
 */
@Injectable()
export class AccessReevaluator implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly access: AccessService,
    private readonly rooms: RoomManager,
    private readonly metrics: CollabMetrics,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.reevaluate({}),
      this.config.get('COLLAB_ACCESS_RECHECK_MS', { infer: true }),
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Re-reads the permissions of every open socket matching `filter` (all of them for `{}`). */
  async reevaluate(filter: {
    documentIds?: readonly string[];
    userId?: string;
    workspaceId?: string;
  }): Promise<void> {
    const sessions = this.rooms.matching(filter);
    for (let i = 0; i < sessions.length; i += BATCH_SIZE) {
      await Promise.all(sessions.slice(i, i + BATCH_SIZE).map((session) => this.check(session)));
    }
  }

  private async check(session: Session): Promise<void> {
    const { conn, room } = session;
    try {
      const outcome = await this.access.resolve(session.identity, session.documentId);
      switch (outcome.status) {
        case 'ok': {
          session.workspaceId = outcome.workspaceId;
          const before = room.accessOf(conn);
          room.setAccess(conn, outcome.access);
          this.metrics.accessChanged(
            before === outcome.access
              ? 'unchanged'
              : outcome.access === 'VIEW' || outcome.access === 'COMMENT'
                ? 'readonly'
                : 'editable',
          );
          return;
        }
        case 'deleted':
          this.metrics.accessChanged('closed');
          room.kick(conn, COLLAB_CLOSE.deleted, 'document deleted', { type: 'deleted' });
          return;
        case 'not_found':
          this.metrics.accessChanged('closed');
          room.kick(conn, COLLAB_CLOSE.notFound, 'document not found');
          return;
        case 'forbidden':
          this.metrics.accessChanged('closed');
          room.kick(conn, COLLAB_CLOSE.forbidden, 'access revoked');
          return;
      }
    } catch (error) {
      // a database blip must not disconnect everyone; the next tick tries again
      this.metrics.accessChanged('error');
      getRootLogger().warn(
        { err: error, documentId: session.documentId, connectionId: conn.id },
        'collab access re-evaluation failed',
      );
    }
  }
}
