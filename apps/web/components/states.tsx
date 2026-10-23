import { AlertTriangle, Inbox, Lock, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

function StateShell({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-16 text-center',
        className,
      )}
    >
      <div className="text-muted-foreground" aria-hidden>
        {icon}
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {children}
    </div>
  );
}

export function EmptyState(props: { title: string; description?: string; children?: ReactNode }) {
  return <StateShell icon={<Inbox className="h-8 w-8" />} {...props} />;
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  correlationId,
  children,
}: {
  title?: string;
  description?: string;
  correlationId?: string;
  children?: ReactNode;
}) {
  return (
    <StateShell
      icon={<AlertTriangle className="h-8 w-8" />}
      title={title}
      description={description}
    >
      {children}
      {correlationId ? (
        <p className="font-mono text-xs text-muted-foreground">Reference: {correlationId}</p>
      ) : null}
    </StateShell>
  );
}

export function ForbiddenState({
  description = "You don't have access to this page.",
}: {
  description?: string;
}) {
  return (
    <StateShell
      icon={<Lock className="h-8 w-8" />}
      title="Access denied"
      description={description}
    />
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}
