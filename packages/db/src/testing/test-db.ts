import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { createPrismaClient, type PrismaClient } from '../client';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

export interface TestDb {
  /** Connection string of the throwaway database. */
  url: string;
  prisma: PrismaClient;
  /** Empties every table (call between tests). */
  truncate(): Promise<void>;
  /** Disconnects and drops the database. */
  close(): Promise<void>;
}

function adminUrl(): URL {
  const raw = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw)
    throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) to a Postgres server for tests');
  return new URL(raw);
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(MIGRATIONS_DIR, name, 'migration.sql'));
}

/**
 * Creates an isolated database on the server named by DATABASE_URL, applies every migration to it
 * and returns a client. Each Jest worker (and each call) gets its own database, so test files can
 * run in parallel.
 */
export async function createTestDb(): Promise<TestDb> {
  const admin = adminUrl();
  const name = `collab_test_${process.env.JEST_WORKER_ID ?? '0'}_${randomBytes(4).toString('hex')}`;

  const adminClient = new Client({ connectionString: admin.toString() });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${name}"`);
  } finally {
    await adminClient.end();
  }

  const url = new URL(admin.toString());
  url.pathname = `/${name}`;

  const migrator = new Client({ connectionString: url.toString() });
  await migrator.connect();
  try {
    for (const file of migrationFiles()) {
      await migrator.query(readFileSync(file, 'utf8'));
    }
  } finally {
    await migrator.end();
  }

  const prisma = createPrismaClient(url.toString());

  return {
    url: url.toString(),
    prisma,
    async truncate() {
      const tables = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
      if (tables.length === 0) return;
      const list = tables.map((t) => `"${t.tablename}"`).join(', ');
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    },
    async close() {
      await prisma.$disconnect();
      const cleaner = new Client({ connectionString: admin.toString() });
      await cleaner.connect();
      try {
        await cleaner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleaner.end();
      }
    },
  };
}
