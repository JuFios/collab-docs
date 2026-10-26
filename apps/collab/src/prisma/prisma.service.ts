import { Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, prismaClientOptions } from '@collab-docs/db';
import { type AppConfig, ReadinessService } from '@collab-docs/nest';

/**
 * The Prisma client as a provider: inject `PrismaService` and use it like `PrismaClient`. Connections open
 * lazily on the first query, and the pool is closed on shutdown.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly readiness: ReadinessService,
  ) {
    super(prismaClientOptions(config.get('DATABASE_URL', { infer: true })));
  }

  onModuleInit(): void {
    this.readiness.register('postgres', () => this.$queryRaw`SELECT 1`);
  }

  // after beforeApplicationShutdown, where the rooms write their last updates
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
