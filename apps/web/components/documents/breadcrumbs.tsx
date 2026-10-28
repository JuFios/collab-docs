import type { TreeNode } from '@collab-docs/shared';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

/** Accessible ancestors only: a parent the caller cannot see is not named, so the trail starts below it. */
export function Breadcrumbs({
  workspaceId,
  path,
  current,
}: {
  workspaceId: string;
  path: readonly TreeNode[];
  current: string;
}) {
  const ancestors = path.slice(0, -1);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 text-sm text-muted-foreground">
      <ol className="flex min-w-0 flex-wrap items-center gap-1">
        <li>
          <Link
            className="hover:text-foreground hover:underline"
            href={`/workspaces/${workspaceId}`}
          >
            Overview
          </Link>
        </li>
        {ancestors.map((node) => (
          <li key={node.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <Link
              className="max-w-40 truncate hover:text-foreground hover:underline"
              href={`/workspaces/${workspaceId}/documents/${node.id}`}
            >
              {node.title || 'Untitled'}
            </Link>
          </li>
        ))}
        <li aria-current="page" className="flex min-w-0 items-center gap-1 text-foreground">
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="max-w-56 truncate">{current || 'Untitled'}</span>
        </li>
      </ol>
    </nav>
  );
}
