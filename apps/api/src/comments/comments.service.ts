import { Injectable } from '@nestjs/common';
import { Prisma } from '@collab-docs/db';
import {
  type MentionWarning,
  MENTIONABLE_MAX_RESULTS,
  type ThreadStatus,
  commentExcerpt,
  parseMentions,
  stripMentions,
} from '@collab-docs/shared';
import { AppException, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';
import { NotificationsService } from '../notifications/notifications.service';
import { CommentBlocksService } from './comment-blocks.service';
import { viewableDocumentSql } from '../permissions/document-access-sql';
import { PermissionsService, notFound } from '../permissions/permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CommentResponse,
  CommentWriteResponse,
  CreateCommentDto,
  CreateThreadDto,
  MentionableUserResponse,
  ThreadResponse,
  ThreadWriteResponse,
} from './comments.dto';

const commentInclude = {
  author: { select: { id: true, name: true } },
  mentions: { include: { user: { select: { name: true } } }, orderBy: { userId: 'asc' } },
} satisfies Prisma.CommentInclude;

const threadInclude = {
  comments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: commentInclude },
} satisfies Prisma.CommentThreadInclude;

type CommentRow = Prisma.CommentGetPayload<{ include: typeof commentInclude }>;
type ThreadRow = Prisma.CommentThreadGetPayload<{ include: typeof threadInclude }>;

interface PreparedBody {
  body: string;
  /** Users the body mentions and may view the document, with their names. */
  mentioned: Map<string, string>;
  warnings: MentionWarning[];
}

/**
 * Threads and comments of a document (spec §3, DOC-5). Access is resolved on the document of the thread on every
 * call and, for writes, again inside the transaction; an id the caller may not know about is a 404, like elsewhere.
 */
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly blocks: CommentBlocksService,
    private readonly notifications: NotificationsService,
    @InjectPinoLogger(CommentsService.name) private readonly logger: PinoLogger,
  ) {}

  async listThreads(documentId: string, status: ThreadStatus): Promise<ThreadResponse[]> {
    const threads = await this.prisma.commentThread.findMany({
      where: {
        documentId,
        // a thread whose comments are all deleted is gone
        comments: { some: { deletedAt: null } },
        ...(status === 'open' ? { resolvedAt: null } : {}),
        ...(status === 'resolved' ? { resolvedAt: { not: null } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: threadInclude,
    });
    const blockIds = threads.length > 0 ? await this.blocks.of(documentId) : null;
    return threads.map((thread) =>
      toThread(thread, blockIds !== null && !blockIds.has(thread.blockId)),
    );
  }

  async createThread(
    userId: string,
    documentId: string,
    dto: CreateThreadDto,
  ): Promise<ThreadWriteResponse> {
    const { thread, comment, warnings, created } = await this.prisma.$transaction(async (tx) => {
      await this.permissions.assertDocumentAccess(userId, documentId, 'COMMENT', tx);
      const prepared = await this.prepareBody(tx, documentId, dto.body);
      const thread = await tx.commentThread.create({
        data: { documentId, blockId: dto.blockId, createdBy: userId },
      });
      const { comment, created } = await this.insertComment(
        tx,
        thread.id,
        documentId,
        userId,
        prepared,
      );
      return { thread, comment, warnings: prepared.warnings, created };
    });
    await this.notifications.announce(created);
    return {
      thread: toThread({ ...thread, comments: [comment] }, false),
      warnings,
    };
  }

  async reply(
    userId: string,
    threadId: string,
    dto: CreateCommentDto,
  ): Promise<CommentWriteResponse> {
    const { comment, warnings, created } = await this.prisma.$transaction(async (tx) => {
      const thread = await this.liveThreadOr404(tx, threadId);
      await this.permissions.assertDocumentAccess(userId, thread.documentId, 'COMMENT', tx);
      const prepared = await this.prepareBody(tx, thread.documentId, dto.body);
      const { comment, created } = await this.insertComment(
        tx,
        thread.id,
        thread.documentId,
        userId,
        prepared,
      );
      return { comment, warnings: prepared.warnings, created };
    });
    await this.notifications.announce(created);
    return { comment: toComment(comment), warnings };
  }

  /** Only the author edits a comment; mentions are re-read, and a user who is mentioned for the first time is notified. */
  async edit(
    userId: string,
    commentId: string,
    dto: CreateCommentDto,
  ): Promise<CommentWriteResponse> {
    const { comment, warnings, created } = await this.prisma.$transaction(async (tx) => {
      const existing = await this.commentOr404(tx, commentId);
      await this.permissions.assertDocumentAccess(
        userId,
        existing.thread.documentId,
        'COMMENT',
        tx,
      );
      if (existing.authorId !== userId) {
        throw new AppException('FORBIDDEN', 'Only the author can edit a comment');
      }
      const prepared = await this.prepareBody(tx, existing.thread.documentId, dto.body);
      const mentionedIds = [...prepared.mentioned.keys()];
      await tx.commentMention.deleteMany({ where: { commentId, userId: { notIn: mentionedIds } } });
      await tx.commentMention.createMany({
        data: mentionedIds.map((id) => ({ commentId, userId: id })),
        skipDuplicates: true,
      });
      const comment = await tx.comment.update({
        where: { id: commentId },
        data: { body: prepared.body, editedAt: new Date() },
        include: commentInclude,
      });
      const created = await this.syncNotifications(
        tx,
        comment,
        existing.thread.documentId,
        prepared,
      );
      return { comment, warnings: prepared.warnings, created };
    });
    await this.notifications.announce(created);
    return { comment: toComment(comment), warnings };
  }

  /** The author, or an owner/admin of the workspace (MANAGE), deletes a comment. The row stays, blank, so the thread keeps its shape. */
  async remove(userId: string, commentId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.commentOr404(tx, commentId);
      const { access } = await this.permissions.assertDocumentAccess(
        userId,
        existing.thread.documentId,
        'VIEW',
        tx,
      );
      if (existing.authorId !== userId && access !== 'MANAGE') {
        throw new AppException('FORBIDDEN', 'Only the author or an admin can delete a comment');
      }
      await tx.comment.update({
        where: { id: commentId },
        data: { deletedAt: new Date(), body: '' },
      });
      await tx.commentMention.deleteMany({ where: { commentId } });
      await this.notifications.removeForComment(tx, commentId);
    });
  }

  /** Idempotent: resolving a resolved thread (or reopening an open one) changes nothing. */
  async setResolved(userId: string, threadId: string, resolved: boolean): Promise<ThreadResponse> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const thread = await this.threadOr404(tx, threadId);
      await this.permissions.assertDocumentAccess(userId, thread.documentId, 'COMMENT', tx);
      if ((thread.resolvedAt !== null) === resolved) return thread;
      return tx.commentThread.update({
        where: { id: thread.id },
        data: resolved
          ? { resolvedAt: new Date(), resolvedBy: userId }
          : { resolvedAt: null, resolvedBy: null },
        include: threadInclude,
      });
    });
    const blockIds = await this.blocks.of(updated.documentId);
    return toThread(updated, blockIds !== null && !blockIds.has(updated.blockId));
  }

  /** Users who may view the document and whose name or email starts with `q`: the candidates of the `@` autocomplete. */
  async mentionable(documentId: string, q: string): Promise<MentionableUserResponse[]> {
    const pattern = `${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.prisma.$queryRaw<MentionableUserResponse[]>`
      WITH candidates AS (
        SELECT wm.user_id FROM workspace_members wm
        JOIN documents dd ON dd.workspace_id = wm.workspace_id WHERE dd.id = ${documentId}::uuid
        UNION
        SELECT s.user_id FROM document_shares s WHERE s.document_id = ${documentId}::uuid
      )
      SELECT u.id, u.name, u.email
      FROM candidates c
      JOIN users u ON u.id = c.user_id
      JOIN documents d ON d.id = ${documentId}::uuid
      WHERE ${viewableDocumentSql(Prisma.sql`u.id`)}
        AND (u.name ILIKE ${pattern} ESCAPE '\\' OR u.email ILIKE ${pattern} ESCAPE '\\')
      ORDER BY lower(u.name), u.id
      LIMIT ${MENTIONABLE_MAX_RESULTS}`;
  }

  /** Just enough to address a reply: the thread exists and still has a comment. */
  private async liveThreadOr404(tx: Prisma.TransactionClient, threadId: string) {
    const thread = await tx.commentThread.findFirst({
      where: { id: threadId, comments: { some: { deletedAt: null } } },
      select: { id: true, documentId: true },
    });
    if (!thread) throw notFound('Thread');
    return thread;
  }

  private async threadOr404(tx: Prisma.TransactionClient, threadId: string): Promise<ThreadRow> {
    const thread = await tx.commentThread.findUnique({
      where: { id: threadId },
      include: threadInclude,
    });
    if (!thread || thread.comments.every((comment) => comment.deletedAt !== null)) {
      throw notFound('Thread');
    }
    return thread;
  }

  private async commentOr404(tx: Prisma.TransactionClient, commentId: string) {
    const comment = await tx.comment.findUnique({
      where: { id: commentId },
      include: { thread: { select: { documentId: true } } },
    });
    if (!comment || comment.deletedAt !== null) throw notFound('Comment');
    return comment;
  }

  /**
   * Reads the mentions of a body and drops the ones that cannot stand: a user who does not exist or may not view the
   * document (they would learn the title and the excerpt from the notification), and those over the limit.
   */
  private async prepareBody(
    tx: Prisma.TransactionClient,
    documentId: string,
    rawBody: string,
  ): Promise<PreparedBody> {
    const parsed = parseMentions(rawBody);
    const mentioned = await this.viewers(tx, documentId, parsed.userIds);
    const ignored = parsed.userIds.filter((id) => !mentioned.has(id));
    const body = stripMentions(rawBody, new Set([...ignored, ...parsed.overflow])).trim();
    if (body === '') throw new AppException('VALIDATION_FAILED', 'A comment cannot be empty');
    return {
      body,
      mentioned,
      warnings: [
        ...ignored.map((userId): MentionWarning => ({ code: 'MENTION_IGNORED', userId })),
        ...parsed.overflow.map((userId): MentionWarning => ({ code: 'MENTION_LIMIT', userId })),
      ],
    };
  }

  /** The given users that may view the document, id to name. */
  private async viewers(
    tx: Prisma.TransactionClient,
    documentId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT u.id, u.name
      FROM users u
      JOIN documents d ON d.id = ${documentId}::uuid
      WHERE u.id = ANY(${userIds}::uuid[]) AND ${viewableDocumentSql(Prisma.sql`u.id`)}`;
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private async insertComment(
    tx: Prisma.TransactionClient,
    threadId: string,
    documentId: string,
    authorId: string,
    prepared: PreparedBody,
  ) {
    const comment = await tx.comment.create({
      data: {
        threadId,
        authorId,
        body: prepared.body,
        mentions: { create: [...prepared.mentioned.keys()].map((userId) => ({ userId })) },
      },
      include: commentInclude,
    });
    const created = await this.syncNotifications(tx, comment, documentId, prepared);
    return { comment, created };
  }

  /** Everyone mentioned except the author gets a notification. */
  private async syncNotifications(
    tx: Prisma.TransactionClient,
    comment: CommentRow,
    documentId: string,
    prepared: PreparedBody,
  ) {
    const document = await tx.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { workspaceId: true, title: true },
    });
    return this.notifications.syncMentions(tx, {
      commentId: comment.id,
      recipientIds: [...prepared.mentioned.keys()].filter((id) => id !== comment.authorId),
      payload: {
        workspaceId: document.workspaceId,
        documentId,
        documentTitle: document.title,
        threadId: comment.threadId,
        commentId: comment.id,
        actor: { id: comment.author.id, name: comment.author.name },
        excerpt: commentExcerpt(comment.body, prepared.mentioned),
      },
    });
  }
}

function toComment(row: CommentRow): CommentResponse {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    author: row.author,
    body: deleted ? '' : row.body,
    deleted,
    mentions: deleted ? [] : row.mentions.map((m) => ({ userId: m.userId, name: m.user.name })),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
  };
}

function toThread(
  row: Omit<ThreadRow, 'comments'> & { comments: CommentRow[] },
  orphaned: boolean,
): ThreadResponse {
  return {
    id: row.id,
    documentId: row.documentId,
    blockId: row.blockId,
    orphaned,
    resolved: row.resolvedAt !== null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    comments: row.comments.map(toComment),
  };
}
