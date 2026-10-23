import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: {
    // Not needed for `prisma generate`; required by migrate commands.
    url: process.env.DATABASE_URL ?? '',
  },
});
