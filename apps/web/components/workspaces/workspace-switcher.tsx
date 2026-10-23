'use client';

import type { Workspace } from '@collab-docs/shared';
import { Check, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { workspaceIdFromPath } from '@/lib/workspaces/last-workspace';

/** Client component: Radix menu, and the pathname decides which workspace is current. Data arrives as typed props. */
export function WorkspaceSwitcher({ workspaces }: { workspaces: readonly Workspace[] }) {
  const pathname = usePathname();
  const currentId = workspaceIdFromPath(pathname);
  const current = workspaces.find((workspace) => workspace.id === currentId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Switch workspace">
          {current?.name ?? 'Workspaces'}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {workspaces.map((workspace) => (
          <DropdownMenuItem key={workspace.id} asChild>
            <Link href={`/w/${workspace.id}`}>
              <span className="flex-1 truncate">{workspace.name}</span>
              {workspace.id === currentId ? (
                <Check className="h-4 w-4" aria-label="Current" />
              ) : null}
            </Link>
          </DropdownMenuItem>
        ))}
        {workspaces.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem asChild>
          <Link href="/w?all=1">All workspaces</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
