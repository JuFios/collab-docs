import { describe, expect, it } from 'vitest';
import {
  type Access,
  type DocumentAccessContext,
  type MoveContext,
  type RoleChange,
  type MemberRemoval,
  type WorkspaceRole,
  canComment,
  canCreateDocument,
  canInviteWithRole,
  canMoveDocument,
  canRestoreDocument,
  checkMemberRemoval,
  checkRoleChange,
  decideDocumentAccess,
  resolveDocumentAccess,
  resolveLinkAccess,
  resolveWorkspaceRole,
} from './permissions';
import { PLAN_CATALOG, limitFor } from './plans';

type Case = [name: string, ctx: Partial<DocumentAccessContext>, expected: Access];

const base: DocumentAccessContext = {
  deleted: false,
  workspaceRole: null,
  shareRole: null,
  visibility: 'WORKSPACE',
};

describe('resolveDocumentAccess', () => {
  const cases: Case[] = [
    // deleted documents are invisible to everybody
    ['deleted, owner', { deleted: true, workspaceRole: 'OWNER' }, 'NONE'],
    ['deleted, admin', { deleted: true, workspaceRole: 'ADMIN' }, 'NONE'],
    [
      'deleted, editor with share',
      { deleted: true, workspaceRole: 'EDITOR', shareRole: 'EDITOR' },
      'NONE',
    ],
    ['deleted, guest with share', { deleted: true, shareRole: 'VIEWER' }, 'NONE'],
    // Owner/Admin always manage, whatever the visibility or a downgrading share
    ['owner, workspace', { workspaceRole: 'OWNER' }, 'MANAGE'],
    ['owner, restricted', { workspaceRole: 'OWNER', visibility: 'RESTRICTED' }, 'MANAGE'],
    ['admin, workspace', { workspaceRole: 'ADMIN' }, 'MANAGE'],
    ['admin, restricted', { workspaceRole: 'ADMIN', visibility: 'RESTRICTED' }, 'MANAGE'],
    [
      'admin, viewer share does not downgrade',
      { workspaceRole: 'ADMIN', shareRole: 'VIEWER' },
      'MANAGE',
    ],
    [
      'owner, viewer share does not downgrade',
      { workspaceRole: 'OWNER', shareRole: 'VIEWER', visibility: 'RESTRICTED' },
      'MANAGE',
    ],
    // plain members on WORKSPACE visibility
    ['editor, workspace', { workspaceRole: 'EDITOR' }, 'EDIT'],
    ['viewer, workspace', { workspaceRole: 'VIEWER' }, 'VIEW'],
    // plain members on RESTRICTED visibility without a share
    ['editor, restricted', { workspaceRole: 'EDITOR', visibility: 'RESTRICTED' }, 'NONE'],
    ['viewer, restricted', { workspaceRole: 'VIEWER', visibility: 'RESTRICTED' }, 'NONE'],
    // a share overrides the workspace role upwards...
    ['viewer + editor share, workspace', { workspaceRole: 'VIEWER', shareRole: 'EDITOR' }, 'EDIT'],
    [
      'viewer + editor share, restricted',
      { workspaceRole: 'VIEWER', shareRole: 'EDITOR', visibility: 'RESTRICTED' },
      'EDIT',
    ],
    [
      'editor + editor share, restricted',
      { workspaceRole: 'EDITOR', shareRole: 'EDITOR', visibility: 'RESTRICTED' },
      'EDIT',
    ],
    [
      'editor + viewer share, restricted',
      { workspaceRole: 'EDITOR', shareRole: 'VIEWER', visibility: 'RESTRICTED' },
      'VIEW',
    ],
    [
      'viewer + viewer share, restricted',
      { workspaceRole: 'VIEWER', shareRole: 'VIEWER', visibility: 'RESTRICTED' },
      'VIEW',
    ],
    // ...and downwards
    ['editor + viewer share, workspace', { workspaceRole: 'EDITOR', shareRole: 'VIEWER' }, 'VIEW'],
    // guests (non-members) only get what is shared with them
    ['guest, no share, workspace', {}, 'NONE'],
    ['guest, no share, restricted', { visibility: 'RESTRICTED' }, 'NONE'],
    ['guest + viewer share, workspace', { shareRole: 'VIEWER' }, 'VIEW'],
    ['guest + editor share, workspace', { shareRole: 'EDITOR' }, 'EDIT'],
    ['guest + viewer share, restricted', { shareRole: 'VIEWER', visibility: 'RESTRICTED' }, 'VIEW'],
    ['guest + editor share, restricted', { shareRole: 'EDITOR', visibility: 'RESTRICTED' }, 'EDIT'],
  ];

  it.each(cases)('%s', (_name, ctx, expected) => {
    expect(resolveDocumentAccess({ ...base, ...ctx })).toBe(expected);
  });

  it('covers every role x visibility x share combination without throwing', () => {
    const roles: Array<WorkspaceRole | null> = ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER', null];
    let count = 0;
    for (const workspaceRole of roles)
      for (const visibility of ['WORKSPACE', 'RESTRICTED'] as const)
        for (const shareRole of [null, 'VIEWER', 'EDITOR'] as const)
          for (const deleted of [false, true]) {
            const result = resolveDocumentAccess({ deleted, workspaceRole, shareRole, visibility });
            expect(['NONE', 'VIEW', 'EDIT', 'MANAGE']).toContain(result);
            count++;
          }
    expect(count).toBe(60);
  });
});

describe('resolveLinkAccess', () => {
  const live = { revoked: false, expired: false };

  it.each([
    ['live VIEW link', { mode: 'VIEW' as const, ...live }, false, 'VIEW'],
    ['live EDIT link', { mode: 'EDIT' as const, ...live }, false, 'EDIT'],
    ['revoked VIEW link', { mode: 'VIEW' as const, revoked: true, expired: false }, false, 'NONE'],
    ['revoked EDIT link', { mode: 'EDIT' as const, revoked: true, expired: false }, false, 'NONE'],
    ['expired EDIT link', { mode: 'EDIT' as const, revoked: false, expired: true }, false, 'NONE'],
    ['link of a deleted document', { mode: 'VIEW' as const, ...live }, true, 'NONE'],
  ])('%s', (_name, link, deleted, expected) => {
    expect(resolveLinkAccess(link, deleted)).toBe(expected);
  });
});

describe('decisions: 404 vs 403', () => {
  it.each([
    ['NONE', 'VIEW', 'NOT_FOUND'],
    ['NONE', 'MANAGE', 'NOT_FOUND'],
    ['VIEW', 'VIEW', 'ALLOW'],
    ['VIEW', 'EDIT', 'FORBIDDEN'],
    ['VIEW', 'COMMENT', 'FORBIDDEN'],
    ['EDIT', 'EDIT', 'ALLOW'],
    ['EDIT', 'MANAGE', 'FORBIDDEN'],
    ['MANAGE', 'EDIT', 'ALLOW'],
  ] as const)('access %s needing %s -> %s', (actual, min, expected) => {
    expect(decideDocumentAccess(actual, min)).toBe(expected);
  });

  it.each([
    [null, 'VIEWER', 'NOT_FOUND'],
    ['VIEWER', 'VIEWER', 'ALLOW'],
    ['VIEWER', 'EDITOR', 'FORBIDDEN'],
    ['EDITOR', 'ADMIN', 'FORBIDDEN'],
    ['ADMIN', 'ADMIN', 'ALLOW'],
    ['ADMIN', 'OWNER', 'FORBIDDEN'],
    ['OWNER', 'OWNER', 'ALLOW'],
  ] as const)('workspace role %s needing %s -> %s', (role, min, expected) => {
    expect(resolveWorkspaceRole(role, min)).toBe(expected);
  });
});

describe('document actions', () => {
  it('restore: Owner/Admin always, Editor only as the author', () => {
    expect(canRestoreDocument('OWNER', false)).toBe(true);
    expect(canRestoreDocument('ADMIN', false)).toBe(true);
    expect(canRestoreDocument('EDITOR', true)).toBe(true);
    expect(canRestoreDocument('EDITOR', false)).toBe(false);
    expect(canRestoreDocument('VIEWER', true)).toBe(false);
    expect(canRestoreDocument(null, true)).toBe(false);
  });

  it('create: EDITOR+ and EDIT on the parent', () => {
    expect(canCreateDocument('EDITOR', null)).toBe(true);
    expect(canCreateDocument('EDITOR', 'EDIT')).toBe(true);
    expect(canCreateDocument('ADMIN', 'MANAGE')).toBe(true);
    expect(canCreateDocument('EDITOR', 'VIEW')).toBe(false);
    expect(canCreateDocument('EDITOR', 'NONE')).toBe(false);
    expect(canCreateDocument('VIEWER', null)).toBe(false);
    expect(canCreateDocument(null, null)).toBe(false);
  });

  describe('move', () => {
    const ok: MoveContext = {
      documentAccess: 'EDIT',
      newParentAccess: 'EDIT',
      sameWorkspace: true,
      createsCycle: false,
    };
    it.each([
      ['allowed', {}, true],
      ['to the root', { newParentAccess: null }, true],
      ['manager', { documentAccess: 'MANAGE' as const, newParentAccess: 'MANAGE' as const }, true],
      ['view-only document', { documentAccess: 'VIEW' as const }, false],
      ['view-only target parent', { newParentAccess: 'VIEW' as const }, false],
      ['hidden target parent', { newParentAccess: 'NONE' as const }, false],
      ['other workspace', { sameWorkspace: false }, false],
      ['cycle', { createsCycle: true }, false],
    ])('%s', (_name, override, expected) => {
      expect(canMoveDocument({ ...ok, ...override })).toBe(expected);
    });
  });

  it('comment: editors and above, not viewers or view-only guests', () => {
    expect(canComment('EDIT', 'EDITOR')).toBe(true);
    expect(canComment('MANAGE', 'ADMIN')).toBe(true);
    expect(canComment('EDIT', null)).toBe(true); // guest with an editor share
    expect(canComment('VIEW', null)).toBe(false);
    expect(canComment('VIEW', 'VIEWER')).toBe(false);
    expect(canComment('EDIT', 'VIEWER')).toBe(false); // viewer role stays read-only on comments
    expect(canComment('NONE', 'OWNER')).toBe(false);
  });
});

describe('member rules', () => {
  const change = (override: Partial<RoleChange>): RoleChange => ({
    actorRole: 'ADMIN',
    targetRole: 'EDITOR',
    newRole: 'VIEWER',
    targetIsLastOwner: false,
    ...override,
  });

  it.each([
    ['admin demotes an editor', {}, null],
    ['admin promotes a viewer to admin', { targetRole: 'VIEWER', newRole: 'ADMIN' }, null],
    [
      'owner changes an admin',
      { actorRole: 'OWNER', targetRole: 'ADMIN', newRole: 'EDITOR' },
      null,
    ],
    ['owner grants OWNER', { actorRole: 'OWNER', newRole: 'OWNER' }, null],
    ['editor cannot change roles', { actorRole: 'EDITOR' }, 'ACTOR_NOT_PERMITTED'],
    ['viewer cannot change roles', { actorRole: 'VIEWER' }, 'ACTOR_NOT_PERMITTED'],
    ['admin cannot modify an owner', { targetRole: 'OWNER' }, 'CANNOT_MODIFY_OWNER'],
    ['admin cannot grant OWNER', { newRole: 'OWNER' }, 'CANNOT_GRANT_OWNER'],
    [
      'last owner cannot be demoted',
      { actorRole: 'OWNER', targetRole: 'OWNER', newRole: 'ADMIN', targetIsLastOwner: true },
      'LAST_OWNER',
    ],
    [
      'an owner may be demoted when another remains',
      { actorRole: 'OWNER', targetRole: 'OWNER', newRole: 'ADMIN' },
      null,
    ],
  ] as const)('role change: %s', (_name, override, expected) => {
    expect(checkRoleChange(change(override as Partial<RoleChange>))).toBe(expected);
  });

  const removal = (override: Partial<MemberRemoval>): MemberRemoval => ({
    actorRole: 'ADMIN',
    targetRole: 'EDITOR',
    self: false,
    targetIsLastOwner: false,
    ...override,
  });

  it.each([
    ['admin removes an editor', {}, null],
    ['owner removes an admin', { actorRole: 'OWNER', targetRole: 'ADMIN' }, null],
    ['viewer leaves', { actorRole: 'VIEWER', targetRole: 'VIEWER', self: true }, null],
    ['editor removes someone', { actorRole: 'EDITOR' }, 'ACTOR_NOT_PERMITTED'],
    ['admin removes an owner', { targetRole: 'OWNER' }, 'CANNOT_MODIFY_OWNER'],
    [
      'last owner cannot leave',
      { actorRole: 'OWNER', targetRole: 'OWNER', self: true, targetIsLastOwner: true },
      'LAST_OWNER',
    ],
    [
      'an owner may leave when another remains',
      { actorRole: 'OWNER', targetRole: 'OWNER', self: true },
      null,
    ],
  ] as const)('removal: %s', (_name, override, expected) => {
    expect(checkMemberRemoval(removal(override as Partial<MemberRemoval>))).toBe(expected);
  });

  it('invites cannot carry the OWNER role', () => {
    expect(canInviteWithRole('OWNER')).toBe(false);
    expect(canInviteWithRole('ADMIN')).toBe(true);
    expect(canInviteWithRole('VIEWER')).toBe(true);
  });
});

describe('plan catalog', () => {
  it('matches decision D13', () => {
    expect(PLAN_CATALOG.FREE).toMatchObject({ maxMembers: 3, maxDocuments: 20 });
    expect(PLAN_CATALOG.PRO).toMatchObject({ maxMembers: 10, maxDocuments: 500 });
    expect(PLAN_CATALOG.TEAM).toMatchObject({ maxMembers: 50, maxDocuments: null });
    expect(PLAN_CATALOG.FREE.maxStorageBytes).toBe(100 * 1024 ** 2);
    expect(PLAN_CATALOG.PRO.maxStorageBytes).toBe(5 * 1024 ** 3);
    expect(PLAN_CATALOG.TEAM.maxStorageBytes).toBe(50 * 1024 ** 3);
  });

  it('looks limits up by kind', () => {
    expect(limitFor('FREE', 'members')).toBe(3);
    expect(limitFor('TEAM', 'documents')).toBeNull();
  });
});
