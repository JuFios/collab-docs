import { Injectable, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, prismaClientOptions } from '@collab-docs/db';
import { type AppConfig, ReadinessService } from '@collab-docs/nest';

/**
 * The Prisma client as a provider: inject `PrismaService` and use it like `PrismaClient`. Connections open
 * lazily on the first query (so a database that is down at start does not stop the process; the readiness
 * probe reports it), and the pool is closed on shutdown.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    config: ConfigService<AppConfig, true>,
    // the worker process has no health endpoint, hence no readiness registry
    @Optional() private readonly readiness?: ReadinessService,
  ) {
    super(prismaClientOptions(config.get('DATABASE_URL', { infer: true })));
  }

  onModuleInit(): void {
    this.readiness?.register('postgres', () => this.$queryRaw`SELECT 1`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
