import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { COLLAB_CLOSE } from '@collab-docs/shared';
import { type AppConfig, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';
import { CollabMetrics } from '../metrics/collab-metrics.service';
import { type Session, RoomManager } from '../rooms/room-manager';
import { AccessService } from './access.service';

const BATCH_SIZE = 25;
/** The longest delay `setTimeout` accepts; a link that expires later is picked up by a later periodic check. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Node can fire a timer a millisecond early; the check compares with the clock, so it must not run before it. */
const EXPIRY_MARGIN_MS = 5;

/**
 * Applies changed permissions to open sockets: read-only on a downgrade, upgraded again on a grant, closed
 * (4403/4404/4410) when access is gone. Triggered by Redis events, by a timer that is the safety net for lost
 * events and, for a guest, by a timer set for the moment their link expires, so that the cut-off does not wait for
 * the next periodic check.
 */
@Injectable()
export class AccessReevaluator implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  /** The newest check started for a session: an older, slower answer must not overwrite a fresher one. */
  private readonly generations = new WeakMap<Session, number>();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly access: AccessService,
    private readonly rooms: RoomManager,
    private readonly metrics: CollabMetrics,
    @InjectPinoLogger(AccessReevaluator.name) private readonly logger: PinoLogger,
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

  /**
   * Makes sure a guest is checked again at the moment their link expires. Call it with every answer that carries
   * `expiresAt`; a later answer replaces the timer, so a link whose expiry was moved is followed.
   */
  watchExpiry(session: Session, expiresAt: number | null): void {
    clearTimeout(session.expiryTimer);
    session.expiryTimer = undefined;
    if (expiresAt === null) return;
    const delay = Math.max(0, expiresAt - Date.now()) + EXPIRY_MARGIN_MS;
    if (delay > MAX_TIMER_MS) return;
    session.expiryTimer = setTimeout(() => void this.check(session), delay);
    session.expiryTimer.unref();
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
    const generation = (this.generations.get(session) ?? 0) + 1;
    this.generations.set(session, generation);
    const { conn, room } = session;
    try {
      const outcome = await this.access.resolve(session.identity, session.documentId);
      // a check started after this one owns the decision, whatever order the answers arrive in
      if (this.generations.get(session) !== generation) return;
      switch (outcome.status) {
        case 'ok': {
          session.workspaceId = outcome.workspaceId;
          this.watchExpiry(session, outcome.expiresAt);
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
      this.logger.warn(
        { err: error, documentId: session.documentId, connectionId: conn.id },
        'collab access re-evaluation failed',
      );
    }
  }
}
