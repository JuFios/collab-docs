import type { TreeNode } from '@collab-docs/shared';
import { describe, expect, it } from 'vitest';
import { ancestorIds, descendantIds, flattenVisible, groupChildren, pathTo } from './tree';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, parent: number | null, position: string): TreeNode => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  title: `Doc ${n}`,
  icon: null,
  position,
  visibility: 'WORKSPACE',
  myAccess: 'EDIT',
});

describe('tree helpers', () => {
  const nodes = [node(3, 1, 'a1'), node(1, null, 'a0'), node(2, 1, 'a0'), node(4, 3, 'a0')];

  it('orders siblings by position and then id', () => {
    const groups = groupChildren([node(2, null, 'a0'), node(1, null, 'a0'), node(3, null, 'Zz')]);
    expect(groups.get(null)?.map((n) => n.id)).toEqual([id(3), id(1), id(2)]);
  });

  it('shows a node whose parent is missing at the root', () => {
    const orphan = node(9, 8, 'a0');
    expect(flattenVisible([orphan], new Set()).map((row) => row.depth)).toEqual([0]);
  });

  it('skips collapsed branches and reports depth', () => {
    expect(flattenVisible(nodes, new Set()).map((row) => row.node.id)).toEqual([id(1)]);
    const rows = flattenVisible(nodes, new Set([id(1)]));
    expect(rows.map((row) => [row.node.id, row.depth, row.hasChildren, row.expanded])).toEqual([
      [id(1), 0, true, true],
      [id(2), 1, false, false],
      [id(3), 1, true, false],
    ]);
  });

  it('finds ancestors, the breadcrumb path and descendants', () => {
    expect(ancestorIds(nodes, id(4))).toEqual([id(3), id(1)]);
    expect(pathTo(nodes, id(4)).map((n) => n.id)).toEqual([id(1), id(3), id(4)]);
    expect(pathTo(nodes, id(99))).toEqual([]);
    expect(descendantIds(nodes, id(1)).sort()).toEqual([id(2), id(3), id(4)].sort());
  });

  it('does not loop on a cycle in bad data', () => {
    const cyclic = [node(1, 2, 'a0'), node(2, 1, 'a0')];
    expect(ancestorIds(cyclic, id(1)).length).toBeLessThanOrEqual(2);
    expect(flattenVisible(cyclic, new Set([id(1), id(2)])).length).toBeLessThanOrEqual(2);
  });
});
