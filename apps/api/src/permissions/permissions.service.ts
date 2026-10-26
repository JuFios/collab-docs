import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@collab-docs/db';
import {
  type Access,
  type Decision,
  type ShareRole,
  type DocumentVisibility,
  type WorkspaceRole,
  decideDocumentAccess,
  resolveDocumentAccess,
  resolveWorkspaceRole,
} from '@collab-docs/shared';
import { AppException } from '@collab-docs/nest';

export interface DocumentAccessResult {
  access: Access;
  /** The caller's role in the document's workspace; `null` for guests. */
  workspaceRole: WorkspaceRole | null;
  /** The caller's explicit share on the document, if any. */
  shareRole: ShareRole | null;
  document: {
    id: string;
    workspaceId: string;
    visibility: DocumentVisibility;
    createdBy: string;
    deletedAt: Date | null;
  };
}

/** Either the client or an open transaction, so callers can re-check permissions inside their transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Absent resources and resources the caller may not know about are both reported as 404. */
export const notFound = (what: string) => new AppException('NOT_FOUND', `${what} not found`);

function raise(decision: Decision, what: string): void {
  if (decision === 'NOT_FOUND') throw notFound(what);
  if (decision === 'FORBIDDEN') {
    throw new AppException('FORBIDDEN', 'You do not have permission to do this');
  }
}

/**
 * Loads the minimal context (membership, share, visibility) from the database and applies the pure
 * resolver from `@collab-docs/shared`. Deliberately uncached: a revoked permission applies to the next request.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaClient) {}

  async getWorkspaceRole(userId: string, workspaceId: string): Promise<WorkspaceRole | null> {
    if (!UUID.test(workspaceId)) return null;
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  /** Returns the caller's role; throws 404 for non-members and 403 below `min`. */
  async assertWorkspaceRole(
    userId: string,
    workspaceId: string,
    min: WorkspaceRole,
  ): Promise<WorkspaceRole> {
    const role = await this.getWorkspaceRole(userId, workspaceId);
    raise(resolveWorkspaceRole(role, min), 'Workspace');
    return role as WorkspaceRole;
  }

  /** `null` when the document does not exist. */
  async getDocumentAccess(
    userId: string,
    documentId: string,
    db: Db = this.prisma,
  ): Promise<DocumentAccessResult | null> {
    if (!UUID.test(documentId)) return null;
    const document = await db.document.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        workspaceId: true,
        visibility: true,
        createdBy: true,
        deletedAt: true,
      },
    });
    if (!document) return null;
    const [member, share] = await Promise.all([
      db.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: document.workspaceId, userId } },
        select: { role: true },
      }),
      db.documentShare.findUnique({
        where: { documentId_userId: { documentId, userId } },
        select: { role: true },
      }),
    ]);
    const workspaceRole = member?.role ?? null;
    const access = resolveDocumentAccess({
      deleted: document.deletedAt !== null,
      workspaceRole,
      shareRole: share?.role ?? null,
      visibility: document.visibility,
    });
    return { access, workspaceRole, shareRole: share?.role ?? null, document };
  }

  /** Throws 404 when the caller has no access at all (or the document does not exist) and 403 below `min`. */
  async assertDocumentAccess(
    userId: string,
    documentId: string,
    min: Access,
    db: Db = this.prisma,
  ): Promise<DocumentAccessResult> {
    const result = await this.getDocumentAccess(userId, documentId, db);
    raise(decideDocumentAccess(result?.access ?? 'NONE', min), 'Document');
    return result as DocumentAccessResult;
  }
}
