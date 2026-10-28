import { Injectable } from '@nestjs/common';
import { Prisma } from '@collab-docs/db';
import {
  type Access,
  type DocumentChangeReason,
  type DocumentVisibility,
  type ShareRole,
  type WorkspaceRole,
  accessAtLeast,
  canCreateDocument,
  canManageDocument,
  canMoveDocument,
  canRestoreDocument,
  createsCycle,
  decideDocumentAccess,
  resolveDocumentAccess,
} from '@collab-docs/shared';
import { AppException, QUEUE_NAMES, QueueService, emitDocumentChanged } from '@collab-docs/nest';
import {
  type DocumentAccessResult,
  PermissionsService,
  notFound,
} from '../permissions/permissions.service';
import { PermEventsService } from '../permissions/perm-events.service';
import { PlanLimitsService, type Tx } from '../workspaces/plan-limits.service';
import type {
  CreateDocumentDto,
  DocumentResponse,
  MoveDocumentDto,
  MovedDocumentResponse,
  RecentDocumentResponse,
  TrashItemResponse,
  TreeNodeResponse,
  UpdateDocumentDto,
} from './documents.dto';
import { LIVE_DOCUMENT, LIVE_DOCUMENT_SQL } from '../prisma/live-document';
import { positionBetween } from './position';
import { TreeCacheService } from './tree-cache.service';
import { buildTree } from './tree';
import { PrismaService } from '../prisma/prisma.service';

interface Changed {
  id: string;
  revision: number;
}

const DOCUMENT_SELECT = {
  id: true,
  workspaceId: true,
  parentId: true,
  title: true,
  icon: true,
  position: true,
  visibility: true,
  createdBy: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DocumentSelect;

type DocumentRow = Prisma.DocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>;

function forbidden(): AppException {
  return new AppException('FORBIDDEN', 'You do not have permission to do this');
}

/** Maps a resolver decision to the shared 404/403 convention. */
function enforce(decision: ReturnType<typeof decideDocumentAccess>, what: string): void {
  if (decision === 'NOT_FOUND') throw notFound(what);
  if (decision === 'FORBIDDEN') throw forbidden();
}

function toChanged(rows: Array<{ id: string; revision: bigint }>): Changed[] {
  return rows.map((row) => ({ id: row.id, revision: Number(row.revision) }));
}

/**
 * Document hierarchy: create, read, update, move, soft delete and restore. Every mutation that touches the
 * tree takes the workspace row lock, so creates, moves, deletes and restores in one workspace serialise (this
 * also covers moves into the root, where there is no parent row to lock, and makes cycles impossible).
 * Side effects (cache version, SSE, Redis, queues) run only after the transaction has committed.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly limits: PlanLimitsService,
    private readonly permEvents: PermEventsService,
    private readonly treeCache: TreeCacheService,
    private readonly queues: QueueService,
  ) {}

  // --- create ---------------------------------------------------------------------------------------------

  async create(
    userId: string,
    workspaceId: string,
    role: WorkspaceRole,
    dto: CreateDocumentDto,
  ): Promise<DocumentResponse> {
    const created = await this.prisma.$transaction(async (tx) => {
      await this.limits.lockWorkspace(tx, workspaceId);
      let parent: DocumentAccessResult | null = null;
      if (dto.parentId) {
        parent = await this.permissions.getDocumentAccess(userId, dto.parentId, tx);
        // a parent from another workspace is indistinguishable from a missing one
        if (!parent || parent.document.workspaceId !== workspaceId) throw notFound('Document');
        if (parent.access === 'NONE') throw notFound('Document');
      }
      if (!canCreateDocument(role, parent?.access ?? null)) {
        // EDITOR+ is guaranteed by the route; what is left is a parent the caller can see but not edit
        throw forbidden();
      }
      await this.limits.assertCanAddDocument(tx, workspaceId);

      const last = await tx.document.findFirst({
        where: { workspaceId, parentId: dto.parentId ?? null, ...LIVE_DOCUMENT },
        orderBy: { position: 'desc' },
        select: { position: true },
      });
      const document = await tx.document.create({
        data: {
          workspaceId,
          parentId: dto.parentId ?? null,
          title: dto.title,
          position: positionBetween(last?.position ?? null, null),
          visibility: parent?.document.visibility ?? 'WORKSPACE',
          createdBy: userId,
        },
        select: DOCUMENT_SELECT,
      });
      if (parent) {
        // snapshot of the parent's shares, not live inheritance (spec §4)
        const shares = await tx.documentShare.findMany({
          where: { documentId: parent.document.id },
          select: { userId: true, role: true },
        });
        if (shares.length > 0) {
          await tx.documentShare.createMany({
            data: shares.map((share) => ({ documentId: document.id, ...share })),
          });
        }
      }
      const access = await this.permissions.getDocumentAccess(userId, document.id, tx);
      return this.toResponse(document, access?.access ?? 'EDIT', document.parentId);
    });
    await this.treeCache.invalidate(workspaceId);
    // a new document is searchable by its title before anyone has typed into it; it has no public page yet
    await emitDocumentChanged(
      this.queues,
      { documentId: created.id, revision: created.revision, reason: 'title' },
      [QUEUE_NAMES.searchSync],
    );
    return created;
  }

  // --- read -----------------------------------------------------------------------------------------------

  async get(userId: string, current: DocumentAccessResult): Promise<DocumentResponse> {
    const document = await this.prisma.document.findUnique({
      where: { id: current.document.id },
      select: DOCUMENT_SELECT,
    });
    if (!document) throw notFound('Document');
    // do not disclose an ancestor the caller cannot see
    let parentId = document.parentId;
    if (parentId) {
      const parent = await this.permissions.getDocumentAccess(userId, parentId);
      if (!parent || parent.access === 'NONE') parentId = null;
    }
    return this.toResponse(document, current.access, parentId);
  }

  async tree(
    userId: string,
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<TreeNodeResponse[]> {
    const [rows, shares] = await Promise.all([
      this.treeCache.rows(workspaceId),
      this.prisma.documentShare.findMany({
        where: { userId, document: { workspaceId } },
        select: { documentId: true, role: true },
      }),
    ]);
    const shareByDocument = new Map<string, ShareRole>(shares.map((s) => [s.documentId, s.role]));
    return buildTree(rows, userId, role, shareByDocument);
  }

  /**
   * Latest changes first. Visibility is filtered in SQL (so the limit applies to documents the caller may open)
   * and the access level is then resolved with the same function as the tree.
   */
  async recent(
    userId: string,
    workspaceId: string,
    role: WorkspaceRole,
    limit: number,
  ): Promise<RecentDocumentResponse[]> {
    const managesAll = role === 'OWNER' || role === 'ADMIN';
    const rows = await this.prisma.document.findMany({
      where: {
        workspaceId,
        ...LIVE_DOCUMENT,
        ...(managesAll
          ? {}
          : {
              OR: [
                { visibility: 'WORKSPACE' },
                { shares: { some: { userId } } },
                ...(role === 'EDITOR' ? [{ createdBy: userId }] : []),
              ],
            }),
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        title: true,
        icon: true,
        visibility: true,
        createdBy: true,
        updatedAt: true,
        shares: { where: { userId }, select: { role: true } },
      },
    });
    return rows.flatMap((row) => {
      const access = resolveDocumentAccess({
        deleted: false,
        workspaceRole: role,
        shareRole: row.shares[0]?.role ?? null,
        visibility: row.visibility,
        isAuthor: row.createdBy === userId,
      });
      return access === 'NONE'
        ? []
        : [
            {
              id: row.id,
              title: row.title,
              icon: row.icon,
              myAccess: access,
              updatedAt: row.updatedAt.toISOString(),
            },
          ];
    });
  }

  // --- update ---------------------------------------------------------------------------------------------

  async update(
    userId: string,
    current: DocumentAccessResult,
    dto: UpdateDocumentDto,
  ): Promise<DocumentResponse> {
    const { document } = current;
    const touchesText = dto.title !== undefined || dto.icon !== undefined;
    if (!touchesText && dto.visibility === undefined) {
      throw new AppException('BAD_REQUEST', 'Nothing to update');
    }
    if (
      dto.visibility !== undefined &&
      !canManageDocument(current.access, document.createdBy === userId)
    ) {
      throw forbidden();
    }
    const visibilityChanged =
      dto.visibility !== undefined && dto.visibility !== document.visibility;

    const updated = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.DocumentUpdateManyMutationInput = {};
      if (dto.title !== undefined) data.title = dto.title;
      if (dto.icon !== undefined) data.icon = dto.icon;
      if (dto.visibility !== undefined) data.visibility = dto.visibility;
      if (touchesText) data.revision = { increment: 1 };
      // the access check ran before this transaction: a concurrent delete turns the update into a 404
      const { count } = await tx.document.updateMany({
        where: { id: document.id, ...LIVE_DOCUMENT },
        data,
      });
      if (count === 0) throw notFound('Document');
      return tx.document.findUniqueOrThrow({ where: { id: document.id }, select: DOCUMENT_SELECT });
    });

    await this.treeCache.invalidate(document.workspaceId);
    if (visibilityChanged) {
      await this.permEvents.permChanged({
        workspaceId: document.workspaceId,
        documentId: document.id,
        reason: 'visibility_changed',
      });
    }
    if (touchesText) {
      await emitDocumentChanged(this.queues, {
        documentId: document.id,
        revision: Number(updated.revision),
        reason: dto.title !== undefined ? 'title' : 'icon',
      });
    }
    return this.toResponse(updated, current.access, updated.parentId);
  }

  // --- move -----------------------------------------------------------------------------------------------

  async move(
    userId: string,
    documentId: string,
    dto: MoveDocumentDto,
  ): Promise<MovedDocumentResponse> {
    const result = await this.prisma.$transaction(async (tx) => {
      const subject = await tx.document.findUnique({
        where: { id: documentId },
        select: { workspaceId: true },
      });
      if (!subject) throw notFound('Document');
      await this.limits.lockWorkspace(tx, subject.workspaceId);

      // re-check under the lock: the guard's answer may predate a concurrent delete or permission change
      const current = await this.permissions.assertDocumentAccess(userId, documentId, 'EDIT', tx);
      const workspaceId = current.document.workspaceId;

      let newParentAccess: Access | null = null;
      let ancestors: string[] = [];
      if (dto.parentId !== null) {
        const parent = await this.permissions.getDocumentAccess(userId, dto.parentId, tx);
        if (!parent) throw notFound('Document');
        enforce(decideDocumentAccess(parent.access, 'EDIT'), 'Document');
        if (parent.document.workspaceId !== workspaceId) {
          throw new AppException('BAD_REQUEST', 'Documents cannot be moved between workspaces');
        }
        newParentAccess = parent.access;
        ancestors = await this.ancestorsOf(tx, dto.parentId);
      }
      const cycle = createsCycle(documentId, dto.parentId, ancestors);
      if (cycle) {
        throw new AppException('CONFLICT', 'A document cannot be moved into its own subtree');
      }
      if (
        !canMoveDocument({
          documentAccess: current.access,
          newParentAccess,
          sameWorkspace: true,
          createsCycle: cycle,
        })
      ) {
        throw forbidden();
      }

      const position = await this.positionFor(tx, workspaceId, documentId, dto);
      await tx.document.update({
        where: { id: documentId },
        data: { parentId: dto.parentId, position },
      });
      return { workspaceId, response: { id: documentId, parentId: dto.parentId, position } };
    });
    await this.treeCache.invalidate(result.workspaceId);
    return result.response;
  }

  /** Ids from `documentId` itself up to the root. */
  private async ancestorsOf(tx: Tx, documentId: string): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM documents WHERE id = ${documentId}::uuid
        UNION
        SELECT d.id, d.parent_id FROM documents d JOIN chain c ON d.id = c.parent_id
      )
      SELECT id FROM chain`;
    return rows.map((row) => row.id);
  }

  /** Fractional key for the requested slot (`afterId` / `beforeId`; neither = end of the new parent's children). */
  private async positionFor(
    tx: Tx,
    workspaceId: string,
    documentId: string,
    dto: MoveDocumentDto,
  ): Promise<string> {
    const siblings = (position?: Prisma.StringFilter, id?: string) => ({
      workspaceId,
      parentId: dto.parentId,
      ...LIVE_DOCUMENT,
      id: id ? id : { not: documentId },
      ...(position ? { position } : {}),
    });
    const positionOf = async (id: string): Promise<string> => {
      if (id === documentId) {
        throw new AppException('BAD_REQUEST', 'A document cannot be its own neighbour');
      }
      const found = await tx.document.findFirst({
        where: siblings(undefined, id),
        select: { position: true },
      });
      if (!found)
        throw new AppException('BAD_REQUEST', 'Neighbour is not a child of the new parent');
      return found.position;
    };
    const edge = async (filter: Prisma.StringFilter, order: 'asc' | 'desc') =>
      (
        await tx.document.findFirst({
          where: siblings(filter),
          orderBy: { position: order },
          select: { position: true },
        })
      )?.position ?? null;

    const after = dto.afterId ? await positionOf(dto.afterId) : null;
    const before = dto.beforeId ? await positionOf(dto.beforeId) : null;
    if (after !== null && before !== null) return positionBetween(after, before);
    if (after !== null) return positionBetween(after, await edge({ gt: after }, 'asc'));
    if (before !== null) return positionBetween(await edge({ lt: before }, 'desc'), before);
    return positionBetween(await edge({ gt: '' }, 'desc'), null);
  }

  // --- soft delete and restore ------------------------------------------------------------------------------

  async remove(userId: string, current: DocumentAccessResult): Promise<void> {
    const workspaceId = current.document.workspaceId;
    const changed = await this.prisma.$transaction(async (tx) => {
      await this.limits.lockWorkspace(tx, workspaceId);
      await this.permissions.assertDocumentAccess(userId, current.document.id, 'EDIT', tx);
      // the whole live subtree goes with the document, including descendants the caller cannot see
      const rows = await tx.$queryRaw<Array<{ id: string; revision: bigint }>>`
        WITH RECURSIVE subtree AS (
          SELECT id FROM documents WHERE id = ${current.document.id}::uuid AND ${LIVE_DOCUMENT_SQL}
          UNION ALL
          SELECT d.id FROM documents d JOIN subtree s ON d.parent_id = s.id WHERE ${LIVE_DOCUMENT_SQL}
        )
        UPDATE documents
           SET deleted_at = now(), deleted_root_id = ${current.document.id}::uuid, revision = revision + 1
         WHERE id IN (SELECT id FROM subtree)
        RETURNING id, revision`;
      if (rows.length === 0) throw notFound('Document');
      return toChanged(rows);
    });
    await this.afterLifecycleChange(workspaceId, changed, 'delete');
  }

  async restore(userId: string, documentId: string): Promise<DocumentResponse> {
    const current = await this.permissions.getDocumentAccess(userId, documentId);
    if (!current) throw notFound('Document');
    // would the caller see it were it not deleted? otherwise it does not exist for them
    const sees = resolveDocumentAccess({
      deleted: false,
      workspaceRole: current.workspaceRole,
      shareRole: current.shareRole,
      visibility: current.document.visibility,
      isAuthor: current.document.createdBy === userId,
    });
    if (sees === 'NONE') throw notFound('Document');
    if (!canRestoreDocument(current.workspaceRole, current.document.createdBy === userId)) {
      throw forbidden();
    }
    const workspaceId = current.document.workspaceId;

    const changed = await this.prisma.$transaction(async (tx) => {
      await this.limits.lockWorkspace(tx, workspaceId);
      const document = await tx.document.findUnique({
        where: { id: documentId },
        select: { deletedAt: true, deletedRootId: true, parentId: true },
      });
      if (!document) throw notFound('Document');
      if (document.deletedAt === null) {
        throw new AppException('CONFLICT', 'The document is not deleted');
      }
      if (document.deletedRootId !== documentId) {
        throw new AppException(
          'CONFLICT',
          'This document was deleted together with a parent; restore the parent instead',
        );
      }
      const [counted] = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM documents WHERE deleted_root_id = ${documentId}::uuid`;
      await this.limits.assertCanAddDocument(tx, workspaceId, Number(counted?.count ?? 0));

      // a parent that is still deleted cannot adopt it: the document returns to the root
      if (document.parentId) {
        const parent = await tx.document.findUnique({
          where: { id: document.parentId },
          select: { deletedAt: true },
        });
        if (!parent || parent.deletedAt !== null) {
          await tx.document.update({ where: { id: documentId }, data: { parentId: null } });
        }
      }
      const rows = await tx.$queryRaw<Array<{ id: string; revision: bigint }>>`
        UPDATE documents
           SET deleted_at = NULL, deleted_root_id = NULL, revision = revision + 1
         WHERE deleted_root_id = ${documentId}::uuid
        RETURNING id, revision`;
      return toChanged(rows);
    });
    await this.afterLifecycleChange(workspaceId, changed, 'restore');

    const restored = await this.permissions.getDocumentAccess(userId, documentId);
    return this.get(userId, restored as DocumentAccessResult);
  }

  async trash(
    userId: string,
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<TrashItemResponse[]> {
    const roots = await this.prisma.$queryRaw<
      Array<{
        id: string;
        title: string;
        icon: string | null;
        visibility: DocumentVisibility;
        created_by: string;
        deleted_at: Date;
        document_count: bigint;
      }>
    >`
      SELECT r.id, r.title, r.icon, r.visibility, r.created_by, r.deleted_at,
             (SELECT count(*) FROM documents d WHERE d.deleted_root_id = r.id) AS document_count
        FROM documents r
       WHERE r.workspace_id = ${workspaceId}::uuid AND r.deleted_at IS NOT NULL AND r.deleted_root_id = r.id
       ORDER BY r.deleted_at DESC, r.id
       LIMIT 200`;
    const shares = await this.prisma.documentShare.findMany({
      where: { userId, documentId: { in: roots.map((root) => root.id) } },
      select: { documentId: true, role: true },
    });
    const shareByDocument = new Map(shares.map((s) => [s.documentId, s.role]));
    return roots
      .filter(
        (root) =>
          resolveDocumentAccess({
            deleted: false,
            workspaceRole: role,
            shareRole: shareByDocument.get(root.id) ?? null,
            visibility: root.visibility,
            isAuthor: root.created_by === userId,
          }) !== 'NONE',
      )
      .map((root) => ({
        id: root.id,
        title: root.title,
        icon: root.icon,
        deletedAt: root.deleted_at.toISOString(),
        documentCount: Number(root.document_count),
        canRestore: canRestoreDocument(role, root.created_by === userId),
      }));
  }

  // --- helpers --------------------------------------------------------------------------------------------

  private async afterLifecycleChange(
    workspaceId: string,
    changed: Changed[],
    reason: Extract<DocumentChangeReason, 'delete' | 'restore'>,
  ): Promise<void> {
    await this.treeCache.invalidate(workspaceId);
    const event = { workspaceId, documentIds: changed.map((c) => c.id) };
    await (reason === 'delete'
      ? this.permEvents.docDeleted(event)
      : this.permEvents.docRestored(event));
    await Promise.all(
      changed.map((c) =>
        emitDocumentChanged(this.queues, { documentId: c.id, revision: c.revision, reason }),
      ),
    );
  }

  private toResponse(
    document: DocumentRow,
    access: Access,
    parentId: string | null,
  ): DocumentResponse {
    return {
      id: document.id,
      workspaceId: document.workspaceId,
      parentId,
      title: document.title,
      icon: document.icon,
      position: document.position,
      visibility: document.visibility,
      createdBy: document.createdBy,
      revision: Number(document.revision),
      myAccess: (accessAtLeast(access, 'VIEW') ? access : 'VIEW') as DocumentResponse['myAccess'],
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    };
  }
}
