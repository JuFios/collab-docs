import {
  type Access,
  type DocumentVisibility,
  type ShareRole,
  type WorkspaceRole,
  resolveDocumentAccess,
} from '@collab-docs/shared';

/** What the tree cache stores per live document; permissions are deliberately not part of it. */
export interface TreeRow {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  position: string;
  visibility: DocumentVisibility;
  createdBy: string;
}

interface TreeNode extends Omit<TreeRow, 'createdBy'> {
  myAccess: Exclude<Access, 'NONE'>;
}

/**
 * Filters the cached rows for one member (spec §4): drops documents without access and lifts a visible document
 * whose parent is hidden to the root, so the id of an inaccessible ancestor is never disclosed.
 */
export function buildTree(
  rows: readonly TreeRow[],
  userId: string,
  workspaceRole: WorkspaceRole,
  shares: ReadonlyMap<string, ShareRole>,
): TreeNode[] {
  const visible: TreeNode[] = [];
  for (const { createdBy, ...row } of rows) {
    const access = resolveDocumentAccess({
      deleted: false,
      workspaceRole,
      shareRole: shares.get(row.id) ?? null,
      visibility: row.visibility,
      isAuthor: createdBy === userId,
    });
    if (access !== 'NONE') visible.push({ ...row, myAccess: access });
  }
  const ids = new Set(visible.map((node) => node.id));
  return visible
    .map((node) => (node.parentId && !ids.has(node.parentId) ? { ...node, parentId: null } : node))
    .sort((a, b) => compare(a.position, b.position) || compare(a.id, b.id));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
