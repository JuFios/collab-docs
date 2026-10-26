import {
  authUserSchema,
  documentSchema,
  inviteListSchema,
  memberListSchema,
  recentDocumentListSchema,
  searchPageSchema,
  sharedDocumentListSchema,
  trashItemListSchema,
  treeNodeListSchema,
  usageSchema,
  workspaceListSchema,
  workspaceSchema,
} from '@collab-docs/shared';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { apiServer } from '@/lib/api/server';
import { isApiError } from '@/lib/api/errors';

/**
 * Read models for Server Components. Each is wrapped in `cache`, so a layout and the page below it that ask for
 * the same thing during one render share a single api call (the api client itself is never cached across requests).
 */
const segment = (id: string) => encodeURIComponent(id);

export const getCurrentUser = cache(() => apiServer('/auth/me', { schema: authUserSchema }));
export const getWorkspaces = cache(() => apiServer('/workspaces', { schema: workspaceListSchema }));
export const getWorkspace = cache((id: string) =>
  apiServer(`/workspaces/${segment(id)}`, { schema: workspaceSchema }),
);
export const getUsage = cache((id: string) =>
  apiServer(`/workspaces/${segment(id)}/usage`, { schema: usageSchema }),
);
export const getMembers = cache((id: string) =>
  apiServer(`/workspaces/${segment(id)}/members`, { schema: memberListSchema }),
);
export const getInvites = cache((id: string) =>
  apiServer(`/workspaces/${segment(id)}/invites`, { schema: inviteListSchema }),
);
export const getRecentDocuments = cache((id: string, limit: number) =>
  apiServer(`/workspaces/${segment(id)}/documents/recent?limit=${limit}`, {
    schema: recentDocumentListSchema,
  }),
);
export const getSharedDocuments = cache(() =>
  apiServer('/me/shared-documents', { schema: sharedDocumentListSchema }),
);

/** Page-level guard: a non-member (a guest with a share, or a stranger) gets the same 404 as an unknown id. */
export async function requireWorkspace(id: string) {
  try {
    return await getWorkspace(id);
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }
}

export const getTree = cache((id: string) =>
  apiServer(`/workspaces/${segment(id)}/documents/tree`, { schema: treeNodeListSchema }),
);
export const getTrash = cache((id: string) =>
  apiServer(`/workspaces/${segment(id)}/trash`, { schema: trashItemListSchema }),
);
export const getDocument = cache((id: string) =>
  apiServer(`/documents/${segment(id)}`, { schema: documentSchema }),
);

export const searchDocuments = cache((id: string, q: string, cursor?: string) => {
  const params = new URLSearchParams({ q });
  if (cursor) params.set('cursor', cursor);
  return apiServer(`/workspaces/${segment(id)}/search?${params.toString()}`, {
    schema: searchPageSchema,
  });
});
