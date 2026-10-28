/**
 * Permission model (spec §4) as pure functions: no I/O, so the api, collab and tests share one definition.
 * Callers load the minimal context (membership, share, visibility) and ask these functions for a decision.
 */

export const WORKSPACE_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type ShareRole = 'VIEWER' | 'EDITOR';
export type DocumentVisibility = 'WORKSPACE' | 'RESTRICTED';

export const ACCESS_LEVELS = ['NONE', 'VIEW', 'COMMENT', 'EDIT', 'MANAGE'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

const ACCESS_RANK: Record<Access, number> = { NONE: 0, VIEW: 1, COMMENT: 2, EDIT: 3, MANAGE: 4 };
const ROLE_RANK: Record<WorkspaceRole, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

export function accessAtLeast(actual: Access, min: Access): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[min];
}

export function roleAtLeast(actual: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[min];
}

/**
 * Outcome of an authorisation check. `NOT_FOUND` is returned when the caller has no access at all, so
 * the existence of the resource is not disclosed; `FORBIDDEN` when access exists but is too low.
 */
export type Decision = 'ALLOW' | 'NOT_FOUND' | 'FORBIDDEN';

export interface DocumentAccessContext {
  /** The document is soft-deleted. */
  deleted: boolean;
  /** Role in the document's workspace; `null` for non-members (including document guests). */
  workspaceRole: WorkspaceRole | null;
  /** Explicit `document_share` of the user on this document. */
  shareRole: ShareRole | null;
  visibility: DocumentVisibility;
  /** The user created the document. */
  isAuthor: boolean;
}

/** Spec §4, rules 1-5. Public links are a separate path (`resolveLinkAccess`). */
export function resolveDocumentAccess(ctx: DocumentAccessContext): Access {
  if (ctx.deleted) return 'NONE';
  if (ctx.workspaceRole === 'OWNER' || ctx.workspaceRole === 'ADMIN') return 'MANAGE';
  // an explicit share overrides the workspace role, upwards and downwards
  if (ctx.shareRole) return ctx.shareRole === 'EDITOR' ? 'EDIT' : 'VIEW';
  // an Editor cannot lock themselves out of a document they wrote; a Viewer author is not upgraded
  if (ctx.isAuthor && ctx.workspaceRole === 'EDITOR') return 'EDIT';
  if (ctx.workspaceRole && ctx.visibility === 'WORKSPACE') {
    return ctx.workspaceRole === 'EDITOR' ? 'EDIT' : 'VIEW';
  }
  return 'NONE';
}

export interface PublicLinkState {
  mode: 'VIEW' | 'EDIT';
  revoked: boolean;
  /** Expiry has passed. */
  expired: boolean;
}

/** Spec §4 rule 6. A VIEW link grants anonymous reading of the published page; a live EDIT link grants EDIT (no comments). */
export function resolveLinkAccess(link: PublicLinkState, documentDeleted: boolean): Access {
  if (documentDeleted || link.revoked || link.expired) return 'NONE';
  return link.mode === 'EDIT' ? 'EDIT' : 'VIEW';
}

export function decideDocumentAccess(actual: Access, min: Access): Decision {
  if (actual === 'NONE') return 'NOT_FOUND';
  return accessAtLeast(actual, min) ? 'ALLOW' : 'FORBIDDEN';
}

/** `role` is the caller's membership (`null` = not a member, which must look like a missing workspace). */
export function resolveWorkspaceRole(role: WorkspaceRole | null, min: WorkspaceRole): Decision {
  if (!role) return 'NOT_FOUND';
  return roleAtLeast(role, min) ? 'ALLOW' : 'FORBIDDEN';
}

/** Restoring a deleted document: Owner/Admin always, an Editor only for documents they created. */
export function canRestoreDocument(role: WorkspaceRole | null, isAuthor: boolean): boolean {
  if (role === 'OWNER' || role === 'ADMIN') return true;
  return role === 'EDITOR' && isAuthor;
}

/** Visibility and sharing: MANAGE, or EDIT for the document's author. */
export function canManageDocument(access: Access, isAuthor: boolean): boolean {
  return access === 'MANAGE' || (isAuthor && accessAtLeast(access, 'EDIT'));
}

/** Creating: role EDITOR+ in the workspace and EDIT on the parent (when there is one). */
export function canCreateDocument(
  role: WorkspaceRole | null,
  parentAccess: Access | null,
): boolean {
  if (!role || !roleAtLeast(role, 'EDITOR')) return false;
  return parentAccess === null || accessAtLeast(parentAccess, 'EDIT');
}

export interface MoveContext {
  documentAccess: Access;
  /** Access to the new parent; `null` when moving to the workspace root. */
  newParentAccess: Access | null;
  sameWorkspace: boolean;
  /** The new parent is the document itself or one of its descendants. */
  createsCycle: boolean;
}

/** Moving: EDIT on the document and on the new parent, same workspace, no cycles. */
export function canMoveDocument(ctx: MoveContext): boolean {
  if (!ctx.sameWorkspace || ctx.createsCycle) return false;
  if (!accessAtLeast(ctx.documentAccess, 'EDIT')) return false;
  return ctx.newParentAccess === null || accessAtLeast(ctx.newParentAccess, 'EDIT');
}

/** Only roles that can edit may comment (Viewers and EDIT-link guests cannot). */
export function canComment(access: Access, workspaceRole: WorkspaceRole | null): boolean {
  if (!accessAtLeast(access, 'COMMENT')) return false;
  return workspaceRole === null || roleAtLeast(workspaceRole, 'EDITOR');
}

// --- Member management rules -------------------------------------------------------------------------------

export type MemberRuleViolation =
  'ACTOR_NOT_PERMITTED' | 'CANNOT_MODIFY_OWNER' | 'CANNOT_GRANT_OWNER' | 'LAST_OWNER';

export interface RoleChange {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
  newRole: WorkspaceRole;
  /** The target is the only remaining OWNER. */
  targetIsLastOwner: boolean;
}

/** Role change: ADMIN+, an Admin can neither touch an Owner nor grant OWNER, the last Owner cannot be demoted. */
export function checkRoleChange(change: RoleChange): MemberRuleViolation | null {
  if (!roleAtLeast(change.actorRole, 'ADMIN')) return 'ACTOR_NOT_PERMITTED';
  if (change.actorRole !== 'OWNER') {
    if (change.targetRole === 'OWNER') return 'CANNOT_MODIFY_OWNER';
    if (change.newRole === 'OWNER') return 'CANNOT_GRANT_OWNER';
  }
  if (change.targetRole === 'OWNER' && change.newRole !== 'OWNER' && change.targetIsLastOwner) {
    return 'LAST_OWNER';
  }
  return null;
}

export interface MemberRemoval {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
  /** The actor removes themselves (leaves the workspace). */
  self: boolean;
  targetIsLastOwner: boolean;
}

/** Removal: anyone may leave (except the last Owner); removing others needs ADMIN+, and an Admin cannot remove an Owner. */
export function checkMemberRemoval(removal: MemberRemoval): MemberRuleViolation | null {
  if (!removal.self) {
    if (!roleAtLeast(removal.actorRole, 'ADMIN')) return 'ACTOR_NOT_PERMITTED';
    if (removal.targetRole === 'OWNER' && removal.actorRole !== 'OWNER') {
      return 'CANNOT_MODIFY_OWNER';
    }
  }
  if (removal.targetRole === 'OWNER' && removal.targetIsLastOwner) return 'LAST_OWNER';
  return null;
}

/** Invites may be created for any role except OWNER. */
export function canInviteWithRole(role: WorkspaceRole): boolean {
  return role !== 'OWNER';
}

/** True when moving `documentId` under `newParentId` would put it inside its own subtree. `ancestors` = ids from the new parent up to the root. */
export function createsCycle(
  documentId: string,
  newParentId: string | null,
  ancestors: readonly string[],
): boolean {
  if (newParentId === null) return false;
  return newParentId === documentId || ancestors.includes(documentId);
}
