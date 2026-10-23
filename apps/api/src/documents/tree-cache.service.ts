import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Counter } from 'prom-client';
import { PrismaClient } from '@collab-docs/db';
import { MetricsService, REDIS_CLIENT, getRootLogger } from '@collab-docs/shared/nest';
import { RealtimeEventsService } from '../realtime';
import type { TreeRow } from './tree';

/** Safety net only: a version bump is what normally retires an entry. */
const ENTRY_TTL_SECONDS = 300;

/**
 * Versioned cache of a workspace's live documents (spec §11): `tree:{workspaceId}:{version}`. Every mutation
 * bumps `tree:ver:{workspaceId}` after its commit, which orphans the old entry. Permissions are never cached;
 * they are applied to the cached rows on every read.
 */
@Injectable()
export class TreeCacheService {
  private readonly lookups: Counter<'result'>;

  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(RealtimeEventsService) private readonly realtime: RealtimeEventsService,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.lookups = new Counter({
      name: 'tree_cache_lookups_total',
      help: 'Document tree cache lookups by result',
      labelNames: ['result'],
      registers: [metrics.registry],
    });
  }

  async rows(workspaceId: string): Promise<TreeRow[]> {
    let version = 0;
    try {
      version = Number((await this.redis.get(this.versionKey(workspaceId))) ?? 0);
      const cached = await this.redis.get(this.entryKey(workspaceId, version));
      if (cached) {
        this.lookups.inc({ result: 'hit' });
        return JSON.parse(cached) as TreeRow[];
      }
    } catch (error) {
      getRootLogger().warn({ err: error }, 'tree cache read failed');
      this.lookups.inc({ result: 'error' });
      return this.load(workspaceId);
    }
    this.lookups.inc({ result: 'miss' });
    const rows = await this.load(workspaceId);
    // keyed by the version read *before* loading: a mutation committed meanwhile has bumped it, so this entry is
    // never read again
    await this.redis
      .set(this.entryKey(workspaceId, version), JSON.stringify(rows), 'EX', ENTRY_TTL_SECONDS)
      .catch((error) => getRootLogger().warn({ err: error }, 'tree cache write failed'));
    return rows;
  }

  /** Call after the mutating transaction committed. Never throws. */
  async invalidate(workspaceId: string): Promise<void> {
    try {
      const version = await this.redis.incr(this.versionKey(workspaceId));
      await this.realtime.publishTreeChanged({ workspaceId, version });
    } catch (error) {
      getRootLogger().warn({ err: error, workspaceId }, 'tree cache invalidation failed');
    }
  }

  private async load(workspaceId: string): Promise<TreeRow[]> {
    return this.prisma.document.findMany({
      where: { workspaceId, deletedAt: null },
      select: {
        id: true,
        parentId: true,
        title: true,
        icon: true,
        position: true,
        visibility: true,
      },
    });
  }

  private versionKey(workspaceId: string): string {
    return `tree:ver:${workspaceId}`;
  }

  private entryKey(workspaceId: string, version: number): string {
    return `tree:${workspaceId}:${version}`;
  }
}
