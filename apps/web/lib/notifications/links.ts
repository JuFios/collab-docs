import type { NotificationResponse } from '@collab-docs/shared';

/** Where a notification leads: the document, with the thread opened (`?thread=` is read by the document page). */
export function notificationHref({ payload }: Pick<NotificationResponse, 'payload'>): string {
  const { workspaceId, documentId, threadId } = payload;
  return `/w/${workspaceId}/d/${documentId}?thread=${threadId}`;
}

export function notificationTitle({ payload }: Pick<NotificationResponse, 'payload'>): string {
  return `${payload.actor.name} mentioned you in “${payload.documentTitle || 'Untitled'}”`;
}
