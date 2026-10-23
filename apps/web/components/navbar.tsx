import type { AuthUser } from '@collab-docs/shared';
import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { UserMenu } from '@/components/user-menu';

/** Server Component shell; the user menu is the only client island. */
export function Navbar({ user }: { user: AuthUser }) {
  return (
    <header className="border-b bg-background">
      <nav
        className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4"
        aria-label="Main"
      >
        <div className="flex items-center gap-4">
          <Link href="/w" className="font-semibold">
            Collab Docs
          </Link>
          {/* workspace switcher: filled in with the workspace screens */}
          <Button variant="ghost" size="sm" disabled aria-label="Workspace switcher (coming soon)">
            Workspaces <ChevronDown className="h-3 w-3" aria-hidden />
          </Button>
        </div>
        <UserMenu user={user} />
      </nav>
    </header>
  );
}
