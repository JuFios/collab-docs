'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

/** Client component: marks the current section from the pathname. */
export function WorkspaceNav({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const pathname = usePathname();
  const base = `/w/${workspaceId}`;
  const links = [
    { href: base, label: 'Overview', active: pathname === base },
    {
      href: `${base}/search`,
      label: 'Search',
      active: pathname.startsWith(`${base}/search`),
    },
    ...(canManage
      ? [
          {
            href: `${base}/settings`,
            label: 'Settings',
            active: pathname.startsWith(`${base}/settings`),
          },
          {
            href: `${base}/billing`,
            label: 'Billing',
            active: pathname.startsWith(`${base}/billing`),
          },
        ]
      : []),
  ];
  return (
    <nav aria-label="Workspace" className="flex gap-1 border-b">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          aria-current={link.active ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            link.active
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
