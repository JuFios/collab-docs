import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

/** Constructor options for a client bound to a Postgres connection string (driver adapter, no native engine). */
export function prismaClientOptions(
  connectionString: string,
): ConstructorParameters<typeof PrismaClient>[0] {
  return { adapter: new PrismaPg({ connectionString }) };
}

/** Creates a client bound to a Postgres connection string. */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient(prismaClientOptions(connectionString));
}

export { PrismaClient };
