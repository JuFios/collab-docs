import { Injectable } from '@nestjs/common';
import { Counter } from '@prometheus-io/client';
import { Prisma } from '@collab-docs/db';
import {
  type MentionNotificationPayload,
  type NotificationPage,
  mentionNotificationPayloadSchema,
} from '@collab-docs/shared';
import {
  InjectPinoLogger,
  MetricsService,
  PinoLogger,
  QueueService,
  logEvent,
} from '@collab-docs/nest';
import { MailQueueService } from '../notifications/mail-queue.service';
import { viewableDocumentSql } from '../permissions/document-access-sql';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { decodeInboxCursor, encodeInboxCursor } from './inbox-cursor';
import type { ListNotificationsQueryDto, MarkReadDto } from './inbox.dto';

export interface MentionNotificationInput {
  commentId: string;
  /** Users to notify; the caller has checked that they may view the document. */
  recipientIds: string[];
  payload: MentionNotificationPayload;
}

export interface CreatedNotification {
  id: string;
  userId: string;
}

interface NotificationRow {
  id: string;
  type: 'MENTION';
  payload: unknown;
  read_at: Date | null;
  created_at: Date;
  created_key: string;
}

/** Key of a mention in a comment: one notification per comment and user, however often the comment is saved. */
const commentKeyPrefix = (commentId: string) => `comment:${commentId}:`;
export const commentMentionKey = (commentId: string, userId: string) =>
  `${commentKeyPrefix(commentId)}${userId}`;

/**
 * The in-app notifications of a user: written in the transaction of the change that causes them, announced after it
 * commits (live event, email), listed with the same access rules as everything else.
 */
@Injectable()
export class InboxService {
  private readonly createdTotal: Counter<'type'>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEventsService,
    private readonly mail: MailQueueService,
    private readonly queues: QueueService,
    metrics: MetricsService,
    @InjectPinoLogger(InboxService.name) private readonly logger: PinoLogger,
  ) {
    this.createdTotal = new Counter({
      name: 'notifications_created_total',
      help: 'In-app notifications created',
      labelNames: ['type'],
      registers: [metrics.registry],
    });
  }

  /**
   * Inside the caller's transaction: makes the mention notifications of a comment match its recipients. Users no
   * longer mentioned lose theirs, the others get the current excerpt, and a user who is new gets one. A
   * notification that exists already (same `dedupe_key`) is never created again, so saving a comment twice, or a
   * retried request, notifies nobody twice; only the notifications that were created are returned.
   */
  async syncMentions(
    tx: Prisma.TransactionClient,
    input: MentionNotificationInput,
  ): Promise<CreatedNotification[]> {
    const prefix = commentKeyPrefix(input.commentId);
    await tx.notification.deleteMany({
      where: { dedupeKey: { startsWith: prefix }, userId: { notIn: input.recipientIds } },
    });
    if (input.recipientIds.length === 0) return [];
    await tx.notification.updateMany({
      where: { dedupeKey: { startsWith: prefix } },
      data: { payload: input.payload },
    });
    return tx.notification.createManyAndReturn({
      data: input.recipientIds.map((userId) => ({
        userId,
        type: 'MENTION' as const,
        payload: input.payload,
        dedupeKey: commentMentionKey(input.commentId, userId),
      })),
      skipDuplicates: true,
      select: { id: true, userId: true },
    });
  }

  /** Inside the caller's transaction: the notifications of a deleted comment go with it (they quote it). */
  async removeForComment(tx: Prisma.TransactionClient, commentId: string): Promise<void> {
    await tx.notification.deleteMany({
      where: { dedupeKey: { startsWith: commentKeyPrefix(commentId) } },
    });
  }

  /**
   * After the transaction has committed. The notification is stored, so a lost live event or email job only delays
   * what the user sees (they find it in the list) or sends; neither fails the request.
   */
  async announce(created: CreatedNotification[]): Promise<void> {
    await Promise.all(
      created.map(async ({ id, userId }) => {
        this.createdTotal.inc({ type: 'MENTION' });
        logEvent(this.logger, 'notification.created', {
          notificationId: id,
          userId,
          type: 'MENTION',
        });
        await this.realtime.publishToUser(userId, {
          type: 'notification.created',
          notificationId: id,
        });
        try {
          await this.mail.sendMention({ notificationId: id });
        } catch (error) {
          this.queues.recordEnqueueFailure('mail', 'mail.enqueue_failed', {
            notificationId: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  async list(userId: string, dto: ListNotificationsQueryDto): Promise<NotificationPage> {
    // the DTO has validated it
    const cursor = dto.cursor === undefined ? null : decodeInboxCursor(dto.cursor);
    const after = cursor
      ? Prisma.sql`AND (n.created_at, n.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : Prisma.empty;
    const unread = dto.unread ? Prisma.sql`AND n.read_at IS NULL` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<NotificationRow[]>`
      SELECT n.id, n.type::text AS type, n.payload, n.read_at, n.created_at, n.created_at::text AS created_key
      FROM notifications n
      JOIN documents d ON d.id = (n.payload->>'documentId')::uuid
      WHERE n.user_id = ${userId}::uuid
        AND ${viewableDocumentSql(Prisma.sql`n.user_id`)}
        ${unread}
        ${after}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${dto.limit + 1}`;

    const page = rows.slice(0, dto.limit);
    const last = page.at(-1);
    return {
      items: page.flatMap((row) => {
        const payload = mentionNotificationPayloadSchema.safeParse(row.payload);
        return payload.success
          ? [
              {
                id: row.id,
                type: row.type,
                payload: payload.data,
                read: row.read_at !== null,
                createdAt: row.created_at.toISOString(),
              },
            ]
          : [];
      }),
      nextCursor:
        rows.length > dto.limit && last
          ? encodeInboxCursor({ createdAt: last.created_key, id: last.id })
          : null,
    };
  }

  /** Counts what `list` would show as unread, so the badge and the list agree. */
  async unreadCount(userId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
      FROM notifications n
      JOIN documents d ON d.id = (n.payload->>'documentId')::uuid
      WHERE n.user_id = ${userId}::uuid
        AND n.read_at IS NULL
        AND ${viewableDocumentSql(Prisma.sql`n.user_id`)}`;
    return Number(row?.count ?? 0n);
  }

  /** Only the caller's own rows are touched; ids of other users' notifications are ignored, not reported. */
  async markRead(userId: string, dto: MarkReadDto): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: {
        userId,
        readAt: null,
        ...(dto.all ? {} : { id: { in: dto.ids ?? [] } }),
      },
      data: { readAt: new Date() },
    });
    return count;
  }
}
