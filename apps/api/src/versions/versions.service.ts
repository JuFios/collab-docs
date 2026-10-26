import { Inject, Injectable } from '@nestjs/common';
import { DocumentVersions, MAX_VERSIONS, PrismaClient } from '@collab-docs/db';
import { sanitizeContent, yDocToContentJson } from '@collab-docs/shared/content';
import { AppException } from '@collab-docs/nest';
import type {
  CreatedVersion,
  DocumentVersion,
  DocumentVersionContent,
  RestoredVersion,
} from '@collab-docs/shared';
import { CollabInternalClient } from '../collab/collab-internal.client';

const SELECT = {
  id: true,
  kind: true,
  label: true,
  title: true,
  createdAt: true,
  author: { select: { id: true, name: true } },
} as const;

interface VersionRow {
  id: string;
  kind: DocumentVersion['kind'];
  label: string | null;
  title: string;
  createdAt: Date;
  author: { id: string; name: string } | null;
}

const present = (row: VersionRow): DocumentVersion => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  title: row.title,
  author: row.author,
  createdAt: row.createdAt.toISOString(),
});

const notFound = () => new AppException('NOT_FOUND', 'Version not found');

/**
 * Version history of a document. Callers check access with `@DocumentAccess`; every query here is scoped to
 * the document id, so a version id of another document is a plain 404.
 */
@Injectable()
export class VersionsService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(DocumentVersions) private readonly versions: DocumentVersions,
    @Inject(CollabInternalClient) private readonly collab: CollabInternalClient,
  ) {}

  /** Newest first. The retention policy keeps this list to at most 100 entries. */
  async list(documentId: string): Promise<DocumentVersion[]> {
    const rows = await this.prisma.documentVersion.findMany({
      where: { documentId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_VERSIONS + 50,
      select: SELECT,
    });
    return rows.map(present);
  }

  async get(documentId: string, versionId: string): Promise<DocumentVersionContent> {
    const row = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId },
      select: SELECT,
    });
    if (!row) throw notFound();
    const doc = await this.versions.readDoc(documentId, versionId);
    if (!doc) throw notFound();
    try {
      return { ...present(row), content: sanitizeContent(yDocToContentJson(doc)) };
    } finally {
      doc.destroy();
    }
  }

  /** A named snapshot of the stored content, taken after asking collab to write its buffer. */
  async createManual(documentId: string, userId: string, label?: string): Promise<CreatedVersion> {
    if ((await this.versions.countManual(documentId)) >= MAX_VERSIONS) {
      throw new AppException(
        'CONFLICT',
        `A document can have at most ${MAX_VERSIONS} saved versions`,
      );
    }
    const flushed = await this.collab.flush(documentId);
    const info = await this.versions.create({
      documentId,
      kind: 'MANUAL',
      label: label || null,
      createdBy: userId,
    });
    const row = await this.prisma.documentVersion.findUniqueOrThrow({
      where: { id: info.id },
      select: SELECT,
    });
    return { ...present(row), flushed };
  }

  /** The content is replaced by the live document in collab, which first snapshots the current state. */
  async restore(documentId: string, versionId: string, userId: string): Promise<RestoredVersion> {
    const exists = await this.prisma.documentVersion.count({
      where: { id: versionId, documentId },
    });
    if (exists === 0) throw notFound();
    return this.collab.restore(documentId, versionId, userId);
  }
}
