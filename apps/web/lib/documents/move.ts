import { type TreeNode, accessAtLeast, createsCycle, positionBetween } from '@collab-docs/shared';
import { ancestorIds, effectiveParentId, groupChildren } from './tree';

export type DropZone = 'before' | 'inside' | 'after';

/** The body of `POST /documents/:id/move`. */
export interface MovePlan {
  parentId: string | null;
  beforeId?: string;
  afterId?: string;
}

export type KeyboardMove = 'up' | 'down' | 'indent' | 'outdent';

/** Fraction of a row's height, from the top and from the bottom, that means "before" and "after". */
const EDGE_ZONE_RATIO = 0.25;

/**
 * Pointer y for a `dragmove` event. The event is dispatched before the drag operation stores the new position, so
 * `operation.position.current` is one move behind; the event's own `to`/`by` carry the position being applied.
 */
export function pointerYOf(move: {
  currentY: number;
  to?: { y: number };
  by?: { y: number };
}): number {
  return move.to?.y ?? move.currentY + (move.by?.y ?? 0);
}

export interface RowRect {
  id: string;
  top: number;
  height: number;
}

/** Row under the pointer (by y) and the zone inside it; `null` when the pointer is outside every row. */
export function locateDrop(
  rects: readonly RowRect[],
  pointerY: number,
): { overId: string; zone: DropZone } | null {
  for (const rect of rects) {
    if (pointerY < rect.top || pointerY > rect.top + rect.height) continue;
    const offset = (pointerY - rect.top) / Math.max(rect.height, 1);
    const zone: DropZone =
      offset < EDGE_ZONE_RATIO ? 'before' : offset > 1 - EDGE_ZONE_RATIO ? 'after' : 'inside';
    return { overId: rect.id, zone };
  }
  return null;
}

interface Context {
  nodes: readonly TreeNode[];
  activeId: string;
}

/** Siblings of `parentId` without the node being moved, in display order. */
function siblingsWithout(nodes: readonly TreeNode[], parentId: string | null, activeId: string) {
  return (groupChildren(nodes).get(parentId) ?? []).filter((node) => node.id !== activeId);
}

/**
 * Checks a target the way the api will (EDIT on the document and on the new parent, no cycle) and drops
 * placements that would not change anything. The api stays the source of truth; this only avoids useless calls.
 */
function validate({ nodes, activeId }: Context, plan: MovePlan): MovePlan | null {
  const active = nodes.find((node) => node.id === activeId);
  if (!active || !accessAtLeast(active.myAccess, 'EDIT')) return null;
  if (plan.parentId !== null) {
    const parent = nodes.find((node) => node.id === plan.parentId);
    if (!parent || !accessAtLeast(parent.myAccess, 'EDIT')) return null;
    if (createsCycle(activeId, plan.parentId, ancestorIds(nodes, plan.parentId))) return null;
  }
  const siblings = siblingsWithout(nodes, plan.parentId, activeId);
  const anchor = plan.beforeId ?? plan.afterId;
  if (anchor !== undefined && !siblings.some((node) => node.id === anchor)) return null;
  const index = insertionIndex(siblings, plan);
  if (effectiveParentId(nodes, active) === plan.parentId) {
    const current = (groupChildren(nodes).get(plan.parentId) ?? []).findIndex(
      (node) => node.id === activeId,
    );
    if (current === index) return null;
  }
  return plan;
}

function insertionIndex(siblings: readonly TreeNode[], plan: MovePlan): number {
  if (plan.beforeId !== undefined) return siblings.findIndex((node) => node.id === plan.beforeId);
  if (plan.afterId !== undefined) return siblings.findIndex((node) => node.id === plan.afterId) + 1;
  return siblings.length;
}

/**
 * Turns a pointer drop on `overId` into a move. Dropping on the lower edge of an expanded parent puts the node
 * first among its children, which is where the indicator is drawn.
 */
export function planDrop(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  activeId: string,
  overId: string,
  zone: DropZone,
): MovePlan | null {
  if (activeId === overId) return null;
  const over = nodes.find((node) => node.id === overId);
  if (!over) return null;
  const context = { nodes, activeId };
  if (zone === 'inside') return validate(context, { parentId: over.id });
  if (zone === 'before') {
    return validate(context, { parentId: effectiveParentId(nodes, over), beforeId: over.id });
  }
  const children = siblingsWithout(nodes, over.id, activeId);
  if (expanded.has(over.id) && children.length > 0) {
    return validate(context, { parentId: over.id, beforeId: children[0]?.id });
  }
  return validate(context, { parentId: effectiveParentId(nodes, over), afterId: over.id });
}

/** Alt+Arrow moves: reorder among siblings, indent under the previous sibling, outdent after the parent. */
export function planKeyboardMove(
  nodes: readonly TreeNode[],
  activeId: string,
  move: KeyboardMove,
): MovePlan | null {
  const active = nodes.find((node) => node.id === activeId);
  if (!active) return null;
  const parentId = effectiveParentId(nodes, active);
  const siblings = groupChildren(nodes).get(parentId) ?? [];
  const index = siblings.findIndex((node) => node.id === activeId);
  const context = { nodes, activeId };
  switch (move) {
    case 'up': {
      const previous = siblings[index - 1];
      return previous ? validate(context, { parentId, beforeId: previous.id }) : null;
    }
    case 'down': {
      const next = siblings[index + 1];
      return next ? validate(context, { parentId, afterId: next.id }) : null;
    }
    case 'indent': {
      const previous = siblings[index - 1];
      return previous ? validate(context, { parentId: previous.id }) : null;
    }
    case 'outdent': {
      if (parentId === null) return null;
      const parent = nodes.find((node) => node.id === parentId);
      if (!parent) return null;
      return validate(context, { parentId: effectiveParentId(nodes, parent), afterId: parent.id });
    }
  }
}

/** The tree as it will look once the api accepts the move: new parent and an order key between the neighbours. */
export function applyMove(
  nodes: readonly TreeNode[],
  activeId: string,
  plan: MovePlan,
): TreeNode[] {
  const active = nodes.find((node) => node.id === activeId);
  if (!active) return [...nodes];
  const siblings = siblingsWithout(nodes, plan.parentId, activeId);
  const index = Math.max(0, Math.min(insertionIndex(siblings, plan), siblings.length));
  let position = active.position;
  try {
    position = positionBetween(
      siblings[index - 1]?.position ?? null,
      siblings[index]?.position ?? null,
    );
  } catch {
    // equal neighbour keys cannot happen with api-issued positions; keep the old key and let the refetch decide
  }
  return nodes.map((node) =>
    node.id === activeId ? { ...node, parentId: plan.parentId, position } : node,
  );
}
