import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

/** Creates a client bound to a Postgres connection string (driver adapter, no native engine). */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export { PrismaClient };
