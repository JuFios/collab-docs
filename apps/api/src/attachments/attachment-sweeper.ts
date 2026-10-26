import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@collab-docs/db';
import { type AppConfig, logEvent } from '@collab-docs/nest';
import { S3Storage } from '../storage/s3.service';

const BATCH = 200;

/** Removes uploads that were presigned but never completed, together with the quota they reserved. */
@Injectable()
export class AttachmentSweeper {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly s3: S3Storage,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Returns how many stale uploads were removed. */
  async sweep(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.get('ATTACHMENT_PENDING_TTL_HOURS', { infer: true }) * 3_600_000,
    );
    let removed = 0;
    for (;;) {
      // Claiming the rows first is what keeps this safe against a completion that is running right now:
      // that one fails its PENDING -> READY update instead of leaving a READY row without an object.
      const claimed = await this.prisma.$queryRaw<Array<{ key: string }>>`
        DELETE FROM attachments WHERE id IN (
          SELECT id FROM attachments WHERE status = 'PENDING' AND created_at < ${cutoff}
          ORDER BY created_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
        ) RETURNING key`;
      for (const { key } of claimed) {
        try {
          await this.s3.delete(key);
        } catch (error) {
          logEvent('attachment.sweep_object_failed', { key, error: String(error) });
        }
      }
      removed += claimed.length;
      if (claimed.length < BATCH) break;
    }
    if (removed > 0) logEvent('attachment.swept', { removed });
    return removed;
  }
}
