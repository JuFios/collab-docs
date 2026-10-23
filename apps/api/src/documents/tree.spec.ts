import type { ShareRole } from '@collab-docs/shared';
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
  ...over,
});

const NO_SHARES = new Map<string, ShareRole>();

describe('buildTree', () => {
  it('sorts by position, then id', () => {
    const tree = buildTree(
      [row('b', null, 'a1'), row('c', null, 'a0'), row('a', null, 'a1')],
      'EDITOR',
      NO_SHARES,
    );
    expect(tree.map((n) => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('reports the access level per node', () => {
    const rows = [row('a', null, 'a0')];
    expect(buildTree(rows, 'VIEWER', NO_SHARES)[0]?.myAccess).toBe('VIEW');
    expect(buildTree(rows, 'EDITOR', NO_SHARES)[0]?.myAccess).toBe('EDIT');
    expect(buildTree(rows, 'ADMIN', NO_SHARES)[0]?.myAccess).toBe('MANAGE');
  });

  it('drops restricted documents without a share, but not for admins', () => {
    const rows = [row('open', null, 'a0'), row('secret', null, 'a1', { visibility: 'RESTRICTED' })];
    expect(buildTree(rows, 'EDITOR', NO_SHARES).map((n) => n.id)).toEqual(['open']);
    expect(buildTree(rows, 'OWNER', NO_SHARES).map((n) => n.id)).toEqual(['open', 'secret']);
  });

  it('lets a share open a restricted document, and overrides the workspace role downwards', () => {
    const rows = [row('secret', null, 'a0', { visibility: 'RESTRICTED' }), row('open', null, 'a1')];
    const shares = new Map<string, ShareRole>([
      ['secret', 'VIEWER'],
      ['open', 'VIEWER'],
    ]);
    const tree = buildTree(rows, 'EDITOR', shares);
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
    const tree = buildTree(rows, 'EDITOR', NO_SHARES);
    expect(tree.map((n) => [n.id, n.parentId])).toEqual([
      ['child', null],
      ['child-of-visible', 'child'],
    ]);
  });
});
