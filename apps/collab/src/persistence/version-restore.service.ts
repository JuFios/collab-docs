import { Inject, Injectable } from '@nestjs/common';
import { DocumentVersions, PrismaClient } from '@collab-docs/db';
import { AppException } from '@collab-docs/nest';
import { DOCUMENT_STORE, type DocumentStore } from '../rooms/document-store';
import { RoomManager } from '../rooms/room-manager';

/**
 * Restores a document to a stored version (spec §5). The content is replaced inside the live room, as one Yjs
 * transaction, so every connected client converges on it and the edit history is never rewritten.
 */
@Injectable()
export class VersionRestoreService {
  constructor(
    private readonly rooms: RoomManager,
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    private readonly versions: DocumentVersions,
    private readonly prisma: PrismaClient,
  ) {}

  /** Returns the document revision after the restore. */
  async restore(documentId: string, versionId: string, userId: string): Promise<number> {
    const snapshot = await this.versions.readDoc(documentId, versionId);
    if (!snapshot) throw new AppException('NOT_FOUND', 'Version not found');
    try {
      const room = await this.rooms.acquire(documentId);
      try {
        // what the room has so far must be in the database before the safety snapshot is taken from it
        await this.store.flush(documentId);
        await this.versions.create({
          documentId,
          kind: 'PRE_RESTORE',
          label: 'Before restore',
          createdBy: userId,
        });
        room.replaceContent(snapshot);
        await this.store.flush(documentId);
      } finally {
        this.rooms.releaseIfEmpty(documentId);
      }
    } finally {
      snapshot.destroy();
    }
    return this.revisionOf(documentId);
  }

  async revisionOf(documentId: string): Promise<number> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { revision: true },
    });
    if (!document) throw new AppException('NOT_FOUND', 'Document not found');
    return Number(document.revision);
  }
}
