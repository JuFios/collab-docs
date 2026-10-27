import { billingOverviewSchema } from '@collab-docs/shared';
import { cache } from 'react';
import { apiServer } from '@/lib/api/server';

/** Read model for the billing page; `cache` shares one api call between a layout and the page below it. */
export const getBilling = cache((workspaceId: string) =>
  apiServer(`/workspaces/${encodeURIComponent(workspaceId)}/billing`, {
    schema: billingOverviewSchema,
  }),
);
