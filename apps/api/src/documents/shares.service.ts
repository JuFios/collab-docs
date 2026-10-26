import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@collab-docs/db';
import { canManageDocument, type ShareRole } from '@collab-docs/shared';
import { AppException } from '@collab-docs/nest';
import { type DocumentAccessResult, notFound } from '../permissions/permissions.service';
import { PermEventsService } from '../permissions/perm-events.service';
import { LIVE_DOCUMENT } from '../prisma/live-document';
import type { ShareResponse, SharedDocumentResponse } from './documents.dto';
import { TreeCacheService } from './tree-cache.service';

/** Sharing by email, for registered users only (P2). Managing shares needs MANAGE, or EDIT for the author. */
@Injectable()
export class SharesService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(PermEventsService) private readonly permEvents: PermEventsService,
    @Inject(TreeCacheService) private readonly treeCache: TreeCacheService,
  ) {}

  private assertCanManage(userId: string, current: DocumentAccessResult): void {
    if (!canManageDocument(current.access, current.document.createdBy === userId)) {
      throw new AppException('FORBIDDEN', 'You do not have permission to do this');
    }
  }

  async list(userId: string, current: DocumentAccessResult): Promise<ShareResponse[]> {
    this.assertCanManage(userId, current);
    const shares = await this.prisma.documentShare.findMany({
      where: { documentId: current.document.id },
      include: { user: { select: { email: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return shares.map((s) => ({
      userId: s.userId,
      email: s.user.email,
      name: s.user.name,
      role: s.role,
    }));
  }

  async add(
    userId: string,
    current: DocumentAccessResult,
    email: string,
    role: ShareRole,
  ): Promise<ShareResponse> {
    this.assertCanManage(userId, current);
    const target = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true },
    });
    if (!target) throw notFound('User');
    if (target.id === userId) {
      throw new AppException('BAD_REQUEST', 'You cannot share a document with yourself');
    }
    const documentId = current.document.id;
    await this.prisma.documentShare.upsert({
      where: { documentId_userId: { documentId, userId: target.id } },
      create: { documentId, userId: target.id, role },
      update: { role },
    });
    await this.changed(current, target.id);
    return { userId: target.id, email: target.email, name: target.name, role };
  }

  async update(
    userId: string,
    current: DocumentAccessResult,
    targetUserId: string,
    role: ShareRole,
  ): Promise<ShareResponse> {
    this.assertCanManage(userId, current);
    const documentId = current.document.id;
    const { count } = await this.prisma.documentShare.updateMany({
      where: { documentId, userId: targetUserId },
      data: { role },
    });
    if (count === 0) throw notFound('Share');
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: targetUserId },
      select: { email: true, name: true },
    });
    await this.changed(current, targetUserId);
    return { userId: targetUserId, email: user.email, name: user.name, role };
  }

  async remove(userId: string, current: DocumentAccessResult, targetUserId: string): Promise<void> {
    this.assertCanManage(userId, current);
    const { count } = await this.prisma.documentShare.deleteMany({
      where: { documentId: current.document.id, userId: targetUserId },
    });
    if (count === 0) throw notFound('Share');
    await this.changed(current, targetUserId);
  }

  /** Documents explicitly shared with the caller (the guest's only entry point, plus members' extra grants). */
  async sharedWith(userId: string): Promise<SharedDocumentResponse[]> {
    const shares = await this.prisma.documentShare.findMany({
      where: { userId, document: LIVE_DOCUMENT },
      include: {
        document: { select: { id: true, workspaceId: true, title: true, icon: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return shares.map((s) => ({ ...s.document, role: s.role }));
  }

  private async changed(current: DocumentAccessResult, targetUserId: string): Promise<void> {
    const { workspaceId, id } = current.document;
    await this.treeCache.invalidate(workspaceId);
    await this.permEvents.permChanged({
      workspaceId,
      userId: targetUserId,
      documentId: id,
      reason: 'share_changed',
    });
  }
}
