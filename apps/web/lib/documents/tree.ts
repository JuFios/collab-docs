import type { TreeNode } from '@collab-docs/shared';

export interface TreeRow {
  node: TreeNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

const byPosition = (a: TreeNode, b: TreeNode) =>
  a.position < b.position
    ? -1
    : a.position > b.position
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

/** A node whose parent is not in the list (hidden from the caller) is shown at the root, like the api does. */
export function effectiveParentId(nodes: readonly TreeNode[], node: TreeNode): string | null {
  if (node.parentId === null) return null;
  return nodes.some((candidate) => candidate.id === node.parentId) ? node.parentId : null;
}

/** Children per parent id (`null` = root), each list in display order. */
export function groupChildren(nodes: readonly TreeNode[]): Map<string | null, TreeNode[]> {
  const ids = new Set(nodes.map((node) => node.id));
  const groups = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const key = node.parentId !== null && ids.has(node.parentId) ? node.parentId : null;
    const siblings = groups.get(key);
    if (siblings) siblings.push(node);
    else groups.set(key, [node]);
  }
  for (const siblings of groups.values()) siblings.sort(byPosition);
  return groups;
}

/** Visible rows in display order; collapsed branches are skipped. A cycle in bad data cannot loop forever. */
export function flattenVisible(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const groups = groupChildren(nodes);
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const node of groups.get(parentId) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      const hasChildren = (groups.get(node.id)?.length ?? 0) > 0;
      const isExpanded = hasChildren && expanded.has(node.id);
      rows.push({ node, depth, hasChildren, expanded: isExpanded });
      if (isExpanded) visit(node.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** Ids from the node's parent up to the root. */
export function ancestorIds(nodes: readonly TreeNode[], id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: string[] = [];
  let current = byId.get(id);
  while (current) {
    const parentId = effectiveParentId(nodes, current);
    if (parentId === null || result.includes(parentId)) break;
    result.push(parentId);
    current = byId.get(parentId);
  }
  return result;
}

/** Root-to-node path including the node itself; empty when the node is not in the tree. */
export function pathTo(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const node = byId.get(id);
  if (!node) return [];
  const ancestors = ancestorIds(nodes, id)
    .map((ancestor) => byId.get(ancestor))
    .filter((ancestor): ancestor is TreeNode => ancestor !== undefined);
  return [...ancestors.reverse(), node];
}

export function descendantIds(nodes: readonly TreeNode[], id: string): string[] {
  const groups = groupChildren(nodes);
  const result: string[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of groups.get(current) ?? []) {
      result.push(child.id);
      stack.push(child.id);
    }
  }
  return result;
}
