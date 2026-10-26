import { Injectable } from '@nestjs/common';
import { type Access, resolveDocumentAccess, resolveLinkAccess } from '@collab-docs/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Who is asking: a signed-in user, or a guest identified by the public link of their ticket. */
export interface Identity {
  userId?: string;
  linkId?: string;
}

export type AccessOutcome =
  | { status: 'ok'; access: Exclude<Access, 'NONE'>; workspaceId: string }
  | { status: 'not_found' }
  | { status: 'deleted' }
  | { status: 'forbidden' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the permissions from the database every time (spec §4: no caching of rights), using the same pure
 * resolver as the api. Called when a socket opens, when a permission event arrives and on the 60 s timer.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(identity: Identity, documentId: string): Promise<AccessOutcome> {
    if (!UUID.test(documentId)) return { status: 'not_found' };
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true, visibility: true, deletedAt: true },
    });
    if (!document) return { status: 'not_found' };
    if (document.deletedAt) return { status: 'deleted' };

    const access = identity.userId
      ? await this.userAccess(identity.userId, documentId, document)
      : identity.linkId
        ? await this.linkAccess(identity.linkId, documentId)
        : 'NONE';
    if (access === 'NONE') return { status: 'forbidden' };
    return { status: 'ok', access, workspaceId: document.workspaceId };
  }

  /** Display name for the presence list; `null` when the user no longer exists. */
  async userName(userId: string): Promise<string | null> {
    if (!UUID.test(userId)) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user?.name ?? null;
  }

  private async userAccess(
    userId: string,
    documentId: string,
    document: { workspaceId: string; visibility: 'WORKSPACE' | 'RESTRICTED' },
  ): Promise<Access> {
    if (!UUID.test(userId)) return 'NONE';
    const [member, share] = await Promise.all([
      this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: document.workspaceId, userId } },
        select: { role: true },
      }),
      this.prisma.documentShare.findUnique({
        where: { documentId_userId: { documentId, userId } },
        select: { role: true },
      }),
    ]);
    return resolveDocumentAccess({
      deleted: false,
      workspaceRole: member?.role ?? null,
      shareRole: share?.role ?? null,
      visibility: document.visibility,
    });
  }

  /** A guest keeps access exactly as long as their link is live: revoked and expired links cut them off. */
  private async linkAccess(linkId: string, documentId: string): Promise<Access> {
    if (!UUID.test(linkId)) return 'NONE';
    const link = await this.prisma.publicLink.findUnique({ where: { id: linkId } });
    if (!link || link.documentId !== documentId) return 'NONE';
    return resolveLinkAccess(
      {
        mode: link.mode,
        revoked: link.revokedAt !== null,
        expired: link.expiresAt !== null && link.expiresAt.getTime() <= Date.now(),
      },
      false,
    );
  }
}
