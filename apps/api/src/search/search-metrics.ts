import { Injectable } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { MetricsService } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';

interface LagRow {
  pending: bigint;
  lag_seconds: number | null;
}

/**
 * How far the index is behind, read from the database when `/metrics` is scraped. It is measured here and not in
 * the worker (which exposes nothing) because the number that matters is the age of the oldest change that has
 * no row yet: a job that keeps failing shows up as a lag that keeps growing.
 */
@Injectable()
export class SearchMetrics {
  constructor(
    private readonly prisma: PrismaService,
    metrics: MetricsService,
  ) {
    const read = () => this.read();
    const lag = new Gauge({
      name: 'search_index_lag_seconds',
      help: 'Age of the oldest document change that is not in the search index yet (0 when it is up to date)',
      registers: [metrics.registry],
      async collect() {
        lag.set((await read())?.lag_seconds ?? 0);
      },
    });
    const pending = new Gauge({
      name: 'search_index_pending_documents',
      help: 'Live documents whose search row is missing or older than the document',
      registers: [metrics.registry],
      async collect() {
        const row = await read();
        if (row) pending.set(Number(row.pending));
      },
    });
  }

  private async read(): Promise<LagRow | undefined> {
    try {
      const [row] = await this.prisma.$queryRaw<LagRow[]>`
        SELECT count(*) AS pending,
               EXTRACT(EPOCH FROM now() - min(GREATEST(d.updated_at, d.content_updated_at)))::float8 AS lag_seconds
        FROM documents d
        LEFT JOIN document_search s ON s.document_id = d.id
        WHERE d.deleted_at IS NULL AND (s.document_id IS NULL OR s.indexed_revision < d.revision)`;
      return row;
    } catch {
      // a scrape must not fail because the database is busy; the gauges keep their last values
      return undefined;
    }
  }
}
