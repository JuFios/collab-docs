import {
  authUserSchema,
  inviteListSchema,
  memberListSchema,
  recentDocumentListSchema,
  sharedDocumentListSchema,
  usageSchema,
  workspaceListSchema,
  workspaceSchema,
} from '@collab-docs/shared';
import { cache } from 'react';
import { apiServer } from '@/lib/api/server';

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
