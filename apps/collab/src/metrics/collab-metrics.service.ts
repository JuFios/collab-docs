import { Inject, Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { MetricsService } from '@collab-docs/nest';
import type { RejectReason, RoomObserver } from '../rooms/doc-room';
import type { PersistenceObserver } from '../rooms/postgres-document-store';

/** Prometheus metrics of the collab service (spec §12); scraped at `/metrics` together with the platform ones. */
@Injectable()
export class CollabMetrics implements RoomObserver, PersistenceObserver {
  private readonly applied: Counter;
  private readonly duplicate: Counter;
  private readonly rejected: Counter<'reason'>;
  private readonly rateLimitedTotal: Counter;
  private readonly wsClose: Counter<'code'>;
  private readonly accessChanges: Counter<'outcome'>;
  private readonly connections: Gauge;
  private readonly rooms: Gauge;
  private readonly persistDuration: Histogram;
  private readonly persistFailures: Counter;
  private readonly compactionDuration: Histogram;
  private readonly compactionRows: Counter;
  private readonly compactionFailures: Counter;
  private readonly badRows: Counter;
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
    this.persistDuration = new Histogram({
      name: 'collab_persist_duration_seconds',
      help: 'Time to write one flush (merged updates + revision bump) to Postgres',
      buckets: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    });
    this.persistFailures = new Counter({
      name: 'collab_persist_failures_total',
      help: 'Flushes that failed; the updates stay buffered and are retried',
      registers,
    });
    this.compactionDuration = new Histogram({
      name: 'collab_compaction_duration_seconds',
      help: 'Time to fold the update log into the compacted state',
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    });
    this.compactionRows = new Counter({
      name: 'collab_compaction_rows_total',
      help: 'Log rows folded into compacted states',
      registers,
    });
    this.compactionFailures = new Counter({
      name: 'collab_compaction_failures_total',
      help: 'Compactions that failed (the log keeps growing until the next one succeeds)',
      registers,
    });
    this.badRows = new Counter({
      name: 'collab_bad_log_rows_total',
      help: 'Update-log rows that could not be decoded and were skipped when a document was loaded',
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

  persisted(seconds: number): void {
    this.persistDuration.observe(seconds);
  }

  persistFailed(): void {
    this.persistFailures.inc();
  }

  compacted(seconds: number, rows: number): void {
    this.compactionDuration.observe(seconds);
    this.compactionRows.inc(rows);
  }

  compactionFailed(): void {
    this.compactionFailures.inc();
  }

  badLogRows(count: number): void {
    this.badRows.inc(count);
  }

  socketClosed(code: number): void {
    this.wsClose.inc({ code: String(code) });
  }

  accessChanged(outcome: 'unchanged' | 'readonly' | 'editable' | 'closed' | 'error'): void {
    this.accessChanges.inc({ outcome });
  }
}
