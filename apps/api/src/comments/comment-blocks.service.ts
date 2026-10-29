import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DocumentStateReader } from '@collab-docs/db';
import { extractBlockIds, yDocToContentJson } from '@collab-docs/shared/content';
import { REDIS_CLIENT, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';

/** Safety net only: a new revision is what normally retires an entry. */
const ENTRY_TTL_SECONDS = 3600;

/**
 * The ids of the blocks a document has now, which tell a thread on a deleted block (orphaned) from a live one.
 * Reading them means loading and decoding the whole stored document, so they are cached under the document's
 * `revision`, which every stored change bumps: `comment-blocks:{documentId}:{revision}`.
 */
@Injectable()
export class CommentBlocksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: DocumentStateReader,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectPinoLogger(CommentBlocksService.name) private readonly logger: PinoLogger,
  ) {}

  /** `null` when the stored state cannot be read: a list is still useful without the orphan flags. */
  async of(documentId: string): Promise<Set<string> | null> {
    // read before the content, so an entry is never older than its key: a change stored meanwhile bumps the revision
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { revision: true },
    });
    if (!document) return null;
    const key = `comment-blocks:${documentId}:${document.revision}`;
    const cached = await this.redis.get(key).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'comment block cache read failed');
      return null;
    });
    if (cached) return new Set(JSON.parse(cached) as string[]);

    const ids = await this.load(documentId);
    if (ids) {
      await this.redis
        .set(key, JSON.stringify([...ids]), 'EX', ENTRY_TTL_SECONDS)
        .catch((error: unknown) =>
          this.logger.warn({ err: error }, 'comment block cache write failed'),
        );
    }
    return ids;
  }

  private async load(documentId: string): Promise<Set<string> | null> {
    try {
      const doc = await this.reader.readDoc(documentId);
      try {
        return new Set(extractBlockIds(yDocToContentJson(doc)));
      } finally {
        doc.destroy();
      }
    } catch (error) {
      this.logger.warn(
        { err: error, documentId },
        'could not read the document to flag orphaned threads',
      );
      return null;
    }
  }
}
