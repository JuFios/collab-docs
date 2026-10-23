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
  reason: 'role_changed' | 'member_removed' | 'share_changed' | 'visibility_changed';
}
