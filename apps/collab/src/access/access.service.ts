import { Injectable } from '@nestjs/common';
import {
  type DocumentAccessSubject,
  findDocumentForAccess,
  findDocumentMembership,
} from '@collab-docs/db';
import {
  type Access,
  UUID_PATTERN,
  resolveDocumentAccess,
  resolveLinkAccess,
} from '@collab-docs/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Who is asking: a signed-in user, or a guest identified by the public link of their ticket. */
export interface Identity {
  userId?: string;
  linkId?: string;
}

export type AccessOutcome =
  | {
      status: 'ok';
      access: Exclude<Access, 'NONE'>;
      workspaceId: string;
      /** When a guest's link stops working (epoch ms); `null` for users and for links without an expiry. */
      expiresAt: number | null;
    }
  | { status: 'not_found' }
  | { status: 'deleted' }
  | { status: 'forbidden' };

/**
 * Reads the permissions from the database every time (spec §4: no caching of rights), with the same loader and pure
 * resolver as the api. Called when a socket opens, when a permission event arrives and on the 60 s timer.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(identity: Identity, documentId: string): Promise<AccessOutcome> {
    return this.resolveFor(identity, await this.loadDocument(documentId));
  }

  /** The document as access sees it; `null` when it does not exist. A room's sockets can share one answer. */
  async loadDocument(documentId: string): Promise<DocumentAccessSubject | null> {
    if (!UUID_PATTERN.test(documentId)) return null;
    return findDocumentForAccess(this.prisma, documentId);
  }

  /** The outcome for `identity` on a document loaded by {@link loadDocument}. */
  async resolveFor(
    identity: Identity,
    document: DocumentAccessSubject | null,
  ): Promise<AccessOutcome> {
    if (!document) return { status: 'not_found' };
    if (document.deletedAt) return { status: 'deleted' };

    let expiresAt: number | null = null;
    let access: Access = 'NONE';
    if (identity.userId) {
      access = await this.userAccess(identity.userId, document);
    } else if (identity.linkId) {
      ({ access, expiresAt } = await this.linkAccess(identity.linkId, document.id));
    }
    if (access === 'NONE') return { status: 'forbidden' };
    return { status: 'ok', access, workspaceId: document.workspaceId, expiresAt };
  }

  /** Display name for the presence list; `null` when the user no longer exists. */
  async userName(userId: string): Promise<string | null> {
    if (!UUID_PATTERN.test(userId)) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user?.name ?? null;
  }

  private async userAccess(userId: string, document: DocumentAccessSubject): Promise<Access> {
    if (!UUID_PATTERN.test(userId)) return 'NONE';
    const { workspaceRole, shareRole } = await findDocumentMembership(
      this.prisma,
      document,
      userId,
    );
    return resolveDocumentAccess({
      deleted: false,
      workspaceRole,
      shareRole,
      visibility: document.visibility,
      isAuthor: document.createdBy === userId,
    });
  }

  /** A guest keeps access exactly as long as their link is live: revoked and expired links cut them off. */
  private async linkAccess(
    linkId: string,
    documentId: string,
  ): Promise<{ access: Access; expiresAt: number | null }> {
    if (!UUID_PATTERN.test(linkId)) return { access: 'NONE', expiresAt: null };
    const link = await this.prisma.publicLink.findUnique({ where: { id: linkId } });
    if (!link || link.documentId !== documentId) return { access: 'NONE', expiresAt: null };
    const expiresAt = link.expiresAt?.getTime() ?? null;
    const access = resolveLinkAccess(
      {
        mode: link.mode,
        revoked: link.revokedAt !== null,
        expired: expiresAt !== null && expiresAt <= Date.now(),
      },
      false,
    );
    return { access, expiresAt };
  }
}
