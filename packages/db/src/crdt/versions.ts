import * as Y from 'yjs';
import { type DocumentVersionKind } from '../generated/enums';
import type { PrismaClient } from '../generated/client';
import type { DocumentStateReader } from './reader';

/** Spec §5 / P13: automatic snapshots kept per document, and the cap on all snapshots of a document. */
export const MAX_AUTO_VERSIONS = 50;
export const MAX_VERSIONS = 100;

/** A snapshot without its (large) state. */
export interface VersionInfo {
  id: string;
  documentId: string;
  kind: DocumentVersionKind;
  label: string | null;
  title: string;
  createdBy: string | null;
  createdAt: Date;
}

const INFO = {
  id: true,
  documentId: true,
  kind: true,
  label: true,
  title: true,
  createdBy: true,
  createdAt: true,
} as const;

export class DocumentVersions {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly reader: DocumentStateReader,
  ) {}

  /** Snapshots the stored content of a document (what is in the database, not what a room still buffers). */
  async create(params: {
    documentId: string;
    kind: DocumentVersionKind;
    label?: string | null;
    createdBy?: string | null;
  }): Promise<VersionInfo> {
    const [stored, document] = await Promise.all([
      this.reader.read(params.documentId),
      this.prisma.document.findUniqueOrThrow({
        where: { id: params.documentId },
        select: { title: true },
      }),
    ]);
    const state = stored.update ?? Y.encodeStateAsUpdate(new Y.Doc());
    return this.prisma.documentVersion.create({
      data: {
        documentId: params.documentId,
        state: Buffer.from(state),
        kind: params.kind,
        label: params.label ?? null,
        title: document.title,
        createdBy: params.createdBy ?? null,
      },
      select: INFO,
    });
  }

  /** The `Y.Doc` of a snapshot (the caller destroys it); `null` when the version does not belong to the document. */
  async readDoc(documentId: string, versionId: string): Promise<Y.Doc | null> {
    const version = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, documentId },
      select: { state: true },
    });
    if (!version) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(version.state));
    return doc;
  }

  async lastAutoAt(documentId: string): Promise<Date | null> {
    const latest = await this.prisma.documentVersion.findFirst({
      where: { documentId, kind: 'AUTO' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return latest?.createdAt ?? null;
  }

  countManual(documentId: string): Promise<number> {
    return this.prisma.documentVersion.count({ where: { documentId, kind: 'MANUAL' } });
  }

  /**
   * Retention: at most `maxAuto` automatic snapshots per document, and at most `maxTotal` snapshots overall
   * per document, where automatic and pre-restore snapshots go first. Manual snapshots are only ever deleted
   * by hand (their number is capped when they are created). Returns the number of deleted snapshots.
   */
  async prune(limits: { maxAuto?: number; maxTotal?: number } = {}): Promise<number> {
    const maxAuto = limits.maxAuto ?? MAX_AUTO_VERSIONS;
    const maxTotal = limits.maxTotal ?? MAX_VERSIONS;
    const auto = await this.prisma.$executeRaw`
      DELETE FROM document_versions WHERE id IN (
        SELECT id FROM (
          SELECT id, row_number() OVER (PARTITION BY document_id ORDER BY created_at DESC, id DESC) AS rn
          FROM document_versions WHERE kind = 'AUTO'
        ) ranked WHERE rn > ${maxAuto})`;
    const total = await this.prisma.$executeRaw`
      DELETE FROM document_versions WHERE id IN (
        SELECT id FROM (
          SELECT id, kind, row_number() OVER (PARTITION BY document_id ORDER BY created_at DESC, id DESC) AS rn
          FROM document_versions
        ) ranked WHERE rn > ${maxTotal} AND kind <> 'MANUAL')`;
    return auto + total;
  }
}
