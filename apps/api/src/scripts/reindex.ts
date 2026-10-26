import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerPlatformModule } from '@collab-docs/nest';
import { SearchIndexModule } from '../search/search.module';
import { SearchIndexService } from '../search/search-index.service';

const USAGE = 'usage: reindex --workspace=<uuid> | --all\n';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The pieces the command needs, without the queue processors: nothing here consumes jobs. */
@Module({ imports: [WorkerPlatformModule.forRoot(), SearchIndexModule] })
class ReindexModule {}

/**
 * Rebuilds the search rows of one workspace (`--workspace=<id>`) or of all of them (`--all`) from the stored
 * documents. For after a change of the text extraction, or to repair an index; the normal path is the queue.
 */
async function reindex(): Promise<void> {
  // `pnpm run reindex -- --workspace=<id>` may pass the separator on
  const args = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === '--'));
  const { values } = parseArgs({
    args,
    options: { workspace: { type: 'string' }, all: { type: 'boolean' } },
  });
  const workspaceId = values.workspace;
  if (Boolean(workspaceId) === Boolean(values.all) || (workspaceId && !UUID.test(workspaceId))) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }

  const app = await NestFactory.createApplicationContext(ReindexModule, { logger: ['error'] });
  try {
    const summary = await app.get(SearchIndexService).reindex({ workspaceId }, (progress) => {
      process.stdout.write(`reindexed ${progress.documents} documents\n`);
    });
    process.stdout.write(
      `done: ${summary.documents} documents, ${summary.indexed} indexed, ${summary.removed} removed\n`,
    );
  } finally {
    await app.close();
  }
}

reindex().catch((error: unknown) => {
  process.stderr.write(
    `reindex failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
