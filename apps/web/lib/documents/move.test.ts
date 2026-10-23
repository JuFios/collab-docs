import type { TreeNode } from '@collab-docs/shared';
import { describe, expect, it } from 'vitest';
import { applyMove, locateDrop, planDrop, planKeyboardMove, pointerYOf } from './move';
import { flattenVisible } from './tree';

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function node(n: number, parent: number | null, position: string, patch: Partial<TreeNode> = {}) {
  return {
    id: id(n),
    parentId: parent === null ? null : id(parent),
    title: `Doc ${n}`,
    icon: null,
    position,
    visibility: 'WORKSPACE',
    myAccess: 'EDIT',
    ...patch,
  } satisfies TreeNode;
}

/**
 * 1 ─ 2
 *   └ 3 ─ 4
 * 5
 * 6
 */
const nodes: TreeNode[] = [
  node(1, null, 'a0'),
  node(2, 1, 'a0'),
  node(3, 1, 'a1'),
  node(4, 3, 'a0'),
  node(5, null, 'a1'),
  node(6, null, 'a2'),
];
const expandedAll = new Set([id(1), id(3)]);

describe('locateDrop', () => {
  const rects = [
    { id: 'a', top: 0, height: 40 },
    { id: 'b', top: 40, height: 40 },
  ];

  it('maps the pointer to the top quarter, middle and bottom quarter of a row', () => {
    expect(locateDrop(rects, 5)).toEqual({ overId: 'a', zone: 'before' });
    expect(locateDrop(rects, 20)).toEqual({ overId: 'a', zone: 'inside' });
    expect(locateDrop(rects, 38)).toEqual({ overId: 'a', zone: 'after' });
    expect(locateDrop(rects, 41)).toEqual({ overId: 'b', zone: 'before' });
  });

  it('finds nothing outside the rows', () => {
    expect(locateDrop(rects, -3)).toBeNull();
    expect(locateDrop(rects, 200)).toBeNull();
  });
});

describe('pointerYOf', () => {
  it('prefers the position the event is about to apply over the stored one', () => {
    expect(pointerYOf({ currentY: 10, to: { y: 42 } })).toBe(42);
    expect(pointerYOf({ currentY: 10, by: { y: 5 } })).toBe(15);
    expect(pointerYOf({ currentY: 10 })).toBe(10);
  });
});

describe('planDrop', () => {
  it('drops inside a node as its last child', () => {
    expect(planDrop(nodes, expandedAll, id(5), id(1), 'inside')).toEqual({ parentId: id(1) });
  });

  it('drops before a node among its siblings', () => {
    expect(planDrop(nodes, expandedAll, id(6), id(5), 'before')).toEqual({
      parentId: null,
      beforeId: id(5),
    });
  });

  it('drops after a collapsed node as a sibling', () => {
    expect(planDrop(nodes, new Set(), id(6), id(1), 'after')).toEqual({
      parentId: null,
      afterId: id(1),
    });
  });

  it('drops after an expanded parent as its first child, where the indicator is drawn', () => {
    expect(planDrop(nodes, expandedAll, id(5), id(1), 'after')).toEqual({
      parentId: id(1),
      beforeId: id(2),
    });
  });

  it('refuses to drop a node into itself or into its own descendant', () => {
    expect(planDrop(nodes, expandedAll, id(1), id(1), 'inside')).toBeNull();
    expect(planDrop(nodes, expandedAll, id(1), id(3), 'inside')).toBeNull();
    expect(planDrop(nodes, expandedAll, id(1), id(4), 'inside')).toBeNull();
    expect(planDrop(nodes, expandedAll, id(1), id(4), 'before')).toBeNull();
  });

  it('ignores a drop that would not change the order', () => {
    expect(planDrop(nodes, expandedAll, id(5), id(6), 'before')).toBeNull();
    expect(planDrop(nodes, expandedAll, id(6), id(5), 'after')).toBeNull();
    expect(planDrop(nodes, expandedAll, id(5), id(5), 'before')).toBeNull();
  });

  it('refuses a target the caller cannot edit', () => {
    const readOnlyParent = nodes.map((n) =>
      n.id === id(5) ? { ...n, myAccess: 'VIEW' as const } : n,
    );
    expect(planDrop(readOnlyParent, expandedAll, id(6), id(5), 'inside')).toBeNull();
    expect(planDrop(readOnlyParent, expandedAll, id(5), id(6), 'before')).toBeNull();
  });

  it('moves to the root from a nested row', () => {
    expect(planDrop(nodes, expandedAll, id(4), id(6), 'after')).toEqual({
      parentId: null,
      afterId: id(6),
    });
  });
});

describe('planKeyboardMove', () => {
  it('moves up and down among siblings', () => {
    expect(planKeyboardMove(nodes, id(6), 'up')).toEqual({ parentId: null, beforeId: id(5) });
    expect(planKeyboardMove(nodes, id(5), 'down')).toEqual({ parentId: null, afterId: id(6) });
    expect(planKeyboardMove(nodes, id(1), 'up')).toBeNull();
    expect(planKeyboardMove(nodes, id(6), 'down')).toBeNull();
  });

  it('indents under the previous sibling and outdents after the parent', () => {
    expect(planKeyboardMove(nodes, id(5), 'indent')).toEqual({ parentId: id(1) });
    expect(planKeyboardMove(nodes, id(1), 'indent')).toBeNull();
    expect(planKeyboardMove(nodes, id(4), 'outdent')).toEqual({ parentId: id(1), afterId: id(3) });
    expect(planKeyboardMove(nodes, id(1), 'outdent')).toBeNull();
  });
});

describe('applyMove', () => {
  it('reparents and orders the node between its new neighbours', () => {
    const next = applyMove(nodes, id(6), { parentId: null, beforeId: id(5) });
    const rows = flattenVisible(next, expandedAll).map((row) => row.node.id);
    expect(rows).toEqual([id(1), id(2), id(3), id(4), id(6), id(5)]);
  });

  it('moves a node under a new parent, last', () => {
    const next = applyMove(nodes, id(5), { parentId: id(1) });
    const rows = flattenVisible(next, expandedAll);
    expect(rows.map((row) => [row.node.id, row.depth])).toEqual([
      [id(1), 0],
      [id(2), 1],
      [id(3), 1],
      [id(4), 2],
      [id(5), 1],
      [id(6), 0],
    ]);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(nodes);
    applyMove(nodes, id(5), { parentId: id(1) });
    expect(JSON.stringify(nodes)).toBe(before);
  });
});
