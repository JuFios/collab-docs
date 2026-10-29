import type { Prisma, PrismaClient } from './generated/client';
import type { DocumentVisibility, ShareRole, WorkspaceRole } from './generated/enums';

/** The client or an open transaction, so that a caller can re-check access inside its own transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

/** The fields of a document that its access depends on. */
export interface DocumentAccessSubject {
  id: string;
  workspaceId: string;
  visibility: DocumentVisibility;
  createdBy: string;
  deletedAt: Date | null;
}

/** What a user holds on a document besides authorship: a role in its workspace and an explicit share. */
export interface DocumentMembership {
  /** `null` for a non-member (a document guest included). */
  workspaceRole: WorkspaceRole | null;
  shareRole: ShareRole | null;
}

/**
 * The inputs of the permission resolver, read the same way by the api and the collab service. Callers check that
 * the ids are UUIDs first and apply the resolver of `@collab-docs/shared` to the result.
 */
export function findDocumentForAccess(
  db: Db,
  documentId: string,
): Promise<DocumentAccessSubject | null> {
  return db.document.findUnique({
    where: { id: documentId },
    select: { id: true, workspaceId: true, visibility: true, createdBy: true, deletedAt: true },
  });
}

/** The user's membership of the document's workspace and their share on it, in two parallel lookups. */
export async function findDocumentMembership(
  db: Db,
  document: Pick<DocumentAccessSubject, 'id' | 'workspaceId'>,
  userId: string,
): Promise<DocumentMembership> {
  const [member, share] = await Promise.all([
    db.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: document.workspaceId, userId } },
      select: { role: true },
    }),
    db.documentShare.findUnique({
      where: { documentId_userId: { documentId: document.id, userId } },
      select: { role: true },
    }),
  ]);
  return { workspaceRole: member?.role ?? null, shareRole: share?.role ?? null };
}
