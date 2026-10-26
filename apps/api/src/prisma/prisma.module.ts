import {
  Global,
  Injectable,
  Module,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, PrismaClient } from '@collab-docs/db';
import { type AppConfig, ReadinessService } from '@collab-docs/nest';

/** Registers the Postgres probe and closes the connection pool on shutdown. */
@Injectable()
class PrismaLifecycle implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly prisma: PrismaClient,
    // the worker process has no health endpoint, hence no readiness registry
    @Optional() private readonly readiness?: ReadinessService,
  ) {}

  onModuleInit(): void {
    this.readiness?.register('postgres', () => this.prisma.$queryRaw`SELECT 1`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Singleton Prisma client: inject `PrismaClient` directly. Connections open lazily on first query. */
@Global()
@Module({
  providers: [
    {
      provide: PrismaClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        createPrismaClient(config.get('DATABASE_URL', { infer: true })),
    },
    PrismaLifecycle,
  ],
  exports: [PrismaClient],
})
export class PrismaModule {}
