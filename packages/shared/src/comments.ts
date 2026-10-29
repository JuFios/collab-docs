import { z } from 'zod';
import { UUID_SOURCE } from './ids';

export const COMMENT_BODY_MAX_LENGTH = 4000;
/** Mentions beyond this in one comment are ignored: each one is a notification and an email. */
export const MAX_MENTIONS_PER_COMMENT = 20;
export const MENTIONABLE_MAX_RESULTS = 10;
export const MENTIONABLE_QUERY_MAX_LENGTH = 50;

export const NOTIFICATION_DEFAULT_LIMIT = 20;
export const NOTIFICATION_MAX_LIMIT = 50;
export const NOTIFICATION_READ_MAX_IDS = 100;
/** Longest excerpt of a comment kept in a notification and an email. */
export const NOTIFICATION_EXCERPT_LENGTH = 140;

export const THREAD_STATUSES = ['open', 'resolved', 'all'] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/** Same shape as the block ids of the content model (`BLOCK_ID_PATTERN`); an anchor is only compared, never interpreted. */
export const BLOCK_ID_FORMAT = /^[A-Za-z0-9_-]{1,64}$/;

export const commentBodySchema = z.string().trim().min(1).max(COMMENT_BODY_MAX_LENGTH);

export const createThreadInputSchema = z.object({
  blockId: z.string().regex(BLOCK_ID_FORMAT),
  body: commentBodySchema,
});
export type CreateThreadInput = z.infer<typeof createThreadInputSchema>;

export const createCommentInputSchema = z.object({ body: commentBodySchema });
export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;

/** A mention inside a comment body: `@[<user id>]`. The client turns a name picked from the autocomplete into it. */
export const MENTION_TOKEN = new RegExp(`@\\[(${UUID_SOURCE})\\]`, 'gi');

export interface ParsedMentions {
  /** Distinct user ids in order of first appearance, lower-case. */
  userIds: string[];
  /** Ids over {@link MAX_MENTIONS_PER_COMMENT}. */
  overflow: string[];
}

/** The users a comment body mentions. Only well-formed ids count; whatever else follows `@` is plain text. */
export function parseMentions(body: string): ParsedMentions {
  const seen = new Set<string>();
  for (const [, id] of body.matchAll(MENTION_TOKEN)) seen.add(id!.toLowerCase());
  const all = [...seen];
  return {
    userIds: all.slice(0, MAX_MENTIONS_PER_COMMENT),
    overflow: all.slice(MAX_MENTIONS_PER_COMMENT),
  };
}

/** Removes the tokens of the given users from a body (mentions that were refused keep no dangling markup). */
export function stripMentions(body: string, userIds: ReadonlySet<string>): string {
  if (userIds.size === 0) return body;
  return body.replace(MENTION_TOKEN, (token, id: string) =>
    userIds.has(id.toLowerCase()) ? '' : token,
  );
}

/** One line of plain text for a notification or an email: tokens become `@Name`, whitespace collapses, long text is cut. */
export function commentExcerpt(body: string, names: ReadonlyMap<string, string>): string {
  const text = body
    .replace(MENTION_TOKEN, (_token, id: string) => `@${names.get(id.toLowerCase()) ?? 'someone'}`)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...text];
  return chars.length <= NOTIFICATION_EXCERPT_LENGTH
    ? text
    : `${chars
        .slice(0, NOTIFICATION_EXCERPT_LENGTH - 1)
        .join('')
        .trimEnd()}…`;
}

export const commentMentionSchema = z.object({ userId: z.string().uuid(), name: z.string() });

export const commentSchema = z.object({
  id: z.string().uuid(),
  author: z.object({ id: z.string().uuid(), name: z.string() }),
  /** Empty for a deleted comment. Plain text with `@[userId]` tokens; never HTML. */
  body: z.string(),
  deleted: z.boolean(),
  mentions: z.array(commentMentionSchema),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
});
export type CommentResponse = z.infer<typeof commentSchema>;

export const mentionWarningSchema = z.object({
  code: z.enum(['MENTION_IGNORED', 'MENTION_LIMIT']),
  userId: z.string().uuid(),
});
export type MentionWarning = z.infer<typeof mentionWarningSchema>;

export const threadSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  blockId: z.string(),
  /** The block no longer exists in the document. */
  orphaned: z.boolean(),
  resolved: z.boolean(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  comments: z.array(commentSchema),
});
export type ThreadResponse = z.infer<typeof threadSchema>;

export const threadWriteResultSchema = z.object({
  thread: threadSchema,
  warnings: z.array(mentionWarningSchema),
});

export const commentWriteResultSchema = z.object({
  comment: commentSchema,
  warnings: z.array(mentionWarningSchema),
});

export const mentionableUserSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string(),
});
export type MentionableUser = z.infer<typeof mentionableUserSchema>;

export const NOTIFICATION_TYPES = ['MENTION'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** What a mention notification stores; names and the excerpt are a snapshot taken when the comment was written. */
export const mentionNotificationPayloadSchema = z.object({
  workspaceId: z.string().uuid(),
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  threadId: z.string().uuid(),
  commentId: z.string().uuid(),
  actor: z.object({ id: z.string().uuid(), name: z.string() }),
  excerpt: z.string(),
});
export type MentionNotificationPayload = z.infer<typeof mentionNotificationPayloadSchema>;

export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(NOTIFICATION_TYPES),
  payload: mentionNotificationPayloadSchema,
  read: z.boolean(),
  createdAt: z.string(),
});
export type NotificationResponse = z.infer<typeof notificationSchema>;

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const unreadCountSchema = z.object({ count: z.number().int().min(0) });
export type UnreadCount = z.infer<typeof unreadCountSchema>;

export const markReadResultSchema = z.object({ updated: z.number().int().min(0) });
export type MarkReadResult = z.infer<typeof markReadResultSchema>;
