/** Redis pub/sub channels the api publishes to after a transaction commits; collab re-evaluates open sockets (spec §4). */
export const PERM_EVENT_CHANNELS = {
  permChanged: 'perm.changed',
  docDeleted: 'doc.deleted',
  docRestored: 'doc.restored',
} as const;

export interface PermChangedEvent {
  workspaceId: string;
  /** Whose access changed; omitted when it changed for many users (e.g. a visibility change). */
  userId?: string;
  documentId?: string;
  reason:
    'role_changed' | 'member_removed' | 'share_changed' | 'visibility_changed' | 'link_changed';
}

/** Published after commit when documents are soft-deleted or restored; collab closes or reopens the affected rooms. */
export interface DocLifecycleEvent {
  workspaceId: string;
  /** The whole affected subtree. */
  documentIds: string[];
  correlationId?: string;
}

/** Single Redis channel carrying the events the api fans out to browsers over SSE (`GET /events/stream`). */
export const REALTIME_CHANNEL = 'realtime.events';

export interface TreeChangedEvent {
  type: 'tree.changed';
  workspaceId: string;
  /** Tree cache version after the mutation; clients refetch the tree when it moves. */
  version: number;
}

/** Events addressed to one user, delivered on every workspace stream that user has open. */
export type UserRealtimeEvent = { type: 'notification.created'; notificationId: string };

export type RealtimeEnvelope =
  | { scope: 'workspace'; workspaceId: string; event: TreeChangedEvent }
  | { scope: 'user'; userId: string; event: UserRealtimeEvent };

/** What changed on a document; consumers of `document.changed` decide what to refresh. */
export const DOCUMENT_CHANGE_REASONS = ['content', 'title', 'icon', 'delete', 'restore'] as const;
export type DocumentChangeReason = (typeof DOCUMENT_CHANGE_REASONS)[number];

export interface DocumentChangedEvent {
  documentId: string;
  revision: number;
  reason: DocumentChangeReason;
}
