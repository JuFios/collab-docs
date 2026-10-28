import type { ShareRole, WorkspaceRole } from '@collab-docs/shared';
import { type TreeRow, buildTree } from './tree';

const row = (
  id: string,
  parentId: string | null,
  position: string,
  over: Partial<TreeRow> = {},
): TreeRow => ({
  id,
  parentId,
  title: id,
  icon: null,
  position,
  visibility: 'WORKSPACE',
  createdBy: 'someone',
  ...over,
});

const NO_SHARES = new Map<string, ShareRole>();
const ME = 'me';

const treeOf = (rows: TreeRow[], role: WorkspaceRole, shares = NO_SHARES, userId = ME) =>
  buildTree(rows, userId, role, shares);

describe('buildTree', () => {
  it('sorts by position, then id', () => {
    const tree = treeOf(
      [row('b', null, 'a1'), row('c', null, 'a0'), row('a', null, 'a1')],
      'EDITOR',
    );
    expect(tree.map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('reports the access level per node', () => {
    const rows = [row('a', null, 'a0')];
    expect(treeOf(rows, 'VIEWER')[0]?.myAccess).toBe('VIEW');
    expect(treeOf(rows, 'EDITOR')[0]?.myAccess).toBe('EDIT');
    expect(treeOf(rows, 'ADMIN')[0]?.myAccess).toBe('MANAGE');
  });

  it('drops restricted documents without a share, but not for admins', () => {
    const rows = [row('open', null, 'a0'), row('secret', null, 'a1', { visibility: 'RESTRICTED' })];
    expect(treeOf(rows, 'EDITOR').map((n) => n.id)).toEqual(['open']);
    expect(treeOf(rows, 'OWNER').map((n) => n.id)).toEqual(['open', 'secret']);
  });

  it('keeps a restricted document for the editor who wrote it, and only for them', () => {
    const rows = [row('mine', null, 'a0', { visibility: 'RESTRICTED', createdBy: ME })];
    expect(treeOf(rows, 'EDITOR').map((n) => [n.id, n.myAccess])).toEqual([['mine', 'EDIT']]);
    expect(treeOf(rows, 'EDITOR', NO_SHARES, 'someone-else')).toEqual([]);
    // a viewer author is not upgraded, and createdBy is not part of the response
    expect(treeOf(rows, 'VIEWER')).toEqual([]);
  });

  it('lets a share open a restricted document, and overrides the workspace role downwards', () => {
    const rows = [row('secret', null, 'a0', { visibility: 'RESTRICTED' }), row('open', null, 'a1')];
    const shares = new Map<string, ShareRole>([
      ['secret', 'VIEWER'],
      ['open', 'VIEWER'],
    ]);
    const tree = treeOf(rows, 'EDITOR', shares);
    expect(tree.map((n) => [n.id, n.myAccess])).toEqual([
      ['secret', 'VIEW'],
      ['open', 'VIEW'],
    ]);
  });

  it('lifts a visible node under a hidden parent to the root without naming the parent', () => {
    const rows = [
      row('parent', null, 'a0', { visibility: 'RESTRICTED' }),
      row('child', 'parent', 'a0'),
      row('child-of-visible', 'child', 'a0'),
    ];
    const tree = treeOf(rows, 'EDITOR');
    expect(tree.map((n) => [n.id, n.parentId])).toEqual([
      ['child', null],
      ['child-of-visible', 'child'],
    ]);
  });
});
