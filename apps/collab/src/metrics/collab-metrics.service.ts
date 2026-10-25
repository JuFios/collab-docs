import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge } from 'prom-client';
import { MetricsService } from '@collab-docs/shared/nest';
import type { RejectReason, RoomObserver } from '../rooms/doc-room';

/** Prometheus metrics of the collab service (spec §12); scraped at `/metrics` together with the platform ones. */
@Injectable()
export class CollabMetrics implements RoomObserver {
  private readonly applied: Counter;
  private readonly duplicate: Counter;
  private readonly rejected: Counter<'reason'>;
  private readonly rateLimitedTotal: Counter;
  private readonly wsClose: Counter<'code'>;
  private readonly accessChanges: Counter<'outcome'>;
  private readonly connections: Gauge;
  private readonly rooms: Gauge;
  private source: { connectionCount(): number; roomCount(): number } | null = null;

  constructor(@Inject(MetricsService) metrics: MetricsService) {
    const registers = [metrics.registry];
    this.applied = new Counter({
      name: 'collab_updates_applied_total',
      help: 'Document updates applied to a room',
      registers,
    });
    this.duplicate = new Counter({
      name: 'collab_updates_duplicate_total',
      help: 'Updates that changed nothing (already known) and were neither stored nor broadcast',
      registers,
    });
    this.rejected = new Counter({
      name: 'collab_updates_rejected_total',
      help: 'Messages refused by the server, by reason',
      labelNames: ['reason'],
      registers,
    });
    this.rateLimitedTotal = new Counter({
      name: 'collab_rate_limited_total',
      help: 'Connections closed for sending too many messages',
      registers,
    });
    this.wsClose = new Counter({
      name: 'collab_ws_close_total',
      help: 'Closed WebSocket connections, by close code',
      labelNames: ['code'],
      registers,
    });
    this.accessChanges = new Counter({
      name: 'collab_access_changes_total',
      help: 'Results of re-evaluating open sockets after a permission event or on the timer',
      labelNames: ['outcome'],
      registers,
    });
    this.connections = new Gauge({
      name: 'collab_connections',
      help: 'Open document connections',
      registers,
      collect: () => this.connections.set(this.source?.connectionCount() ?? 0),
    });
    this.rooms = new Gauge({
      name: 'collab_rooms',
      help: 'Documents currently loaded in memory',
      registers,
      collect: () => this.rooms.set(this.source?.roomCount() ?? 0),
    });
  }

  /** The room manager registers itself so the gauges read live values at scrape time. */
  bind(source: { connectionCount(): number; roomCount(): number }): void {
    this.source = source;
  }

  updateApplied(): void {
    this.applied.inc();
  }

  updateDuplicate(): void {
    this.duplicate.inc();
  }

  updateRejected(reason: RejectReason): void {
    this.rejected.inc({ reason });
  }

  rateLimited(): void {
    this.rateLimitedTotal.inc();
  }

  socketClosed(code: number): void {
    this.wsClose.inc({ code: String(code) });
  }

  accessChanged(outcome: 'unchanged' | 'readonly' | 'editable' | 'closed' | 'error'): void {
    this.accessChanges.inc({ outcome });
  }
}
