import { z } from 'zod';
import { planTierSchema } from './plans';
import { usableEmail } from './auth';
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

export const WORKSPACE_NAME_MAX_LENGTH = 80;

/** Same rule as the api DTO: trimmed, 1..80 characters. */
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a workspace name.')
  .max(WORKSPACE_NAME_MAX_LENGTH, `Use at most ${WORKSPACE_NAME_MAX_LENGTH} characters.`);

export const createWorkspaceInputSchema = z.object({ name: workspaceNameSchema });
export const renameWorkspaceInputSchema = createWorkspaceInputSchema;

/** Roles an invite can carry (never OWNER). */
export const INVITABLE_ROLES = WORKSPACE_ROLES.filter((role) => role !== 'OWNER');

export const inviteInputSchema = z.object({
  email: usableEmail,
  role: z.enum(INVITABLE_ROLES, { error: 'Choose a role.' }),
});

export const memberSchema = z.object({
  userId: z.string().uuid(),
  name: z.string(),
  email: z.string(),
  role: workspaceRoleSchema,
  joinedAt: z.string(),
});
export const memberListSchema = z.array(memberSchema);

export const inviteSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: workspaceRoleSchema,
  expiresAt: z.string(),
  createdAt: z.string(),
  invitedBy: z.string().uuid(),
});
export const inviteListSchema = z.array(inviteSchema);

export const invitePreviewSchema = z.object({
  workspaceName: z.string(),
  email: z.string(),
  role: workspaceRoleSchema,
  inviterName: z.string(),
  expiresAt: z.string(),
});

export const acceptInviteSchema = z.object({
  workspaceId: z.string().uuid(),
  role: workspaceRoleSchema,
});

export const usageSchema = z.object({
  plan: planTierSchema,
  members: z.object({
    current: z.number().int(),
    pendingInvites: z.number().int(),
    limit: z.number().int(),
  }),
  documents: z.object({ current: z.number().int(), limit: z.number().int().nullable() }),
  storage: z.object({ currentBytes: z.number(), limitBytes: z.number() }),
});

/** `details` of a `PLAN_LIMIT_EXCEEDED` error response. */
export const planLimitDetailsSchema = z.object({
  kind: z.enum(['members', 'documents', 'storage']),
  limit: z.number(),
  current: z.number(),
  plan: planTierSchema,
});

const accessSchema = z.enum(['VIEW', 'COMMENT', 'EDIT', 'MANAGE']);

export const recentDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  icon: z.string().nullable(),
  myAccess: accessSchema,
  updatedAt: z.string(),
});
export const recentDocumentListSchema = z.array(recentDocumentSchema);

export const sharedDocumentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string(),
  icon: z.string().nullable(),
  role: z.enum(['VIEWER', 'EDITOR']),
});
export const sharedDocumentListSchema = z.array(sharedDocumentSchema);

export type Member = z.infer<typeof memberSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type InvitePreview = z.infer<typeof invitePreviewSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type PlanLimitDetails = z.infer<typeof planLimitDetailsSchema>;
export type RecentDocument = z.infer<typeof recentDocumentSchema>;
export type SharedDocument = z.infer<typeof sharedDocumentSchema>;
