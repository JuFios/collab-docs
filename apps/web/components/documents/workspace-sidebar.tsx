'use client';

import { PanelLeft, Share2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/components/workspaces/workspace-provider';
import { cn } from '@/lib/utils';
import { DocumentTree } from './document-tree';

/** Left column of every workspace page: the document tree, Trash and Shared with me. */
export function WorkspaceSidebar() {
  const { workspaceId } = useWorkspace();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const trashHref = `/w/${workspaceId}/trash`;

  return (
    <aside aria-label="Workspace navigation" className="min-w-0">
      <Button
        variant="outline"
        size="sm"
        className="md:hidden"
        aria-expanded={open}
        aria-controls="workspace-sidebar-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <PanelLeft className="h-4 w-4" aria-hidden />
        Documents
      </Button>
      <div
        id="workspace-sidebar-panel"
        className={cn(
          'mt-3 md:mt-0 md:sticky md:top-4 md:block md:max-h-[calc(100vh-2rem)] md:overflow-y-auto',
          open ? 'block' : 'hidden',
        )}
      >
        <DocumentTree />
        <nav aria-label="Library" className="mt-4 grid gap-px border-t pt-3 text-sm">
          <Link
            href="/shared"
            className="flex h-8 items-center gap-2 rounded-md px-2 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <Share2 className="h-4 w-4" aria-hidden /> Shared with me
          </Link>
          <Link
            href={trashHref}
            aria-current={pathname === trashHref ? 'page' : undefined}
            className={cn(
              'flex h-8 items-center gap-2 rounded-md px-2 hover:bg-accent/60',
              pathname === trashHref
                ? 'bg-accent font-medium'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Trash2 className="h-4 w-4" aria-hidden /> Trash
          </Link>
        </nav>
      </div>
    </aside>
  );
}
