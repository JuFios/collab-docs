import { z } from 'zod';
import { planTierSchema } from './plans';
import { WORKSPACE_ROLES } from './permissions';

export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);

/** A workspace as seen by one member (`role` is the caller's role). */
export const workspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  role: workspaceRoleSchema,
  plan: planTierSchema,
  createdAt: z.string(),
});

export const workspaceListSchema = z.array(workspaceSchema);

export type Workspace = z.infer<typeof workspaceSchema>;
