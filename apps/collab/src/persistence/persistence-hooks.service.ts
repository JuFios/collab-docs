import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentVersions } from '@collab-docs/db';
import {
  type AppConfig,
  QueueService,
  emitDocumentChanged,
  InjectPinoLogger,
  PinoLogger,
} from '@collab-docs/nest';
import type { PersistenceHooks } from '../rooms/postgres-document-store';

/**
 * What surrounds a write: the `document.changed` event for the derived-data queues (spec §7a) after a committed
 * flush, and the automatic version, taken of the state **before** the first change after a pause (so restoring it
 * undoes that editing session). Both are fire-and-forget: a Redis outage or a failed snapshot is logged and
 * counted, and editing carries on.
 */
@Injectable()
export class PersistenceHooksService implements PersistenceHooks {
  /** Last automatic snapshot per loaded document (epoch ms); read from the database the first time. */
  private readonly lastAuto = new Map<string, Promise<number>>();

  constructor(
    private readonly queues: QueueService,
    private readonly versions: DocumentVersions,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(PersistenceHooksService.name) private readonly logger: PinoLogger,
  ) {}

  /** Work started by `contentPersisted`; shutdown waits for it so it does not run against closed connections. */
  private readonly inflight = new Set<Promise<unknown>>();

  contentPersisted(documentId: string, revision: number): void {
    this.track(emitDocumentChanged(this.queues, { documentId, revision, reason: 'content' }));
  }

  changeStarting(documentId: string, stateBefore: Uint8Array): void {
    this.track(this.snapshotIfDue(documentId, stateBefore));
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }

  released(documentId: string): void {
    this.lastAuto.delete(documentId);
  }

  private async snapshotIfDue(documentId: string, state: Uint8Array): Promise<void> {
    try {
      const last = await this.lastSnapshotAt(documentId);
      if (Date.now() - last < this.config.get('AUTO_VERSION_INTERVAL_MS', { infer: true })) return;
      // claim the slot first so a burst of flushes takes one snapshot
      this.lastAuto.set(documentId, Promise.resolve(Date.now()));
      await this.versions.create({ documentId, kind: 'AUTO', state });
    } catch (error) {
      this.lastAuto.delete(documentId);
      this.logger.warn({ err: error, documentId }, 'automatic version failed');
    }
  }

  private lastSnapshotAt(documentId: string): Promise<number> {
    let last = this.lastAuto.get(documentId);
    if (!last) {
      last = this.versions.lastAutoAt(documentId).then((at) => at?.getTime() ?? 0);
      this.lastAuto.set(documentId, last);
    }
    return last;
  }
}
