import { AlertTriangle, Inbox, Lock, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A full-page state is the page's only heading, so it is an `h1`; inside a page it is an `h2`. */
type HeadingLevel = 1 | 2;

function StateShell({
  icon,
  title,
  description,
  children,
  className,
  headingLevel = 2,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
  className?: string;
  headingLevel?: HeadingLevel;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
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
      <Heading className="text-lg font-semibold">{title}</Heading>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
      {children}
    </div>
  );
}

export function EmptyState(props: {
  title: string;
  description?: string;
  children?: ReactNode;
  headingLevel?: HeadingLevel;
}) {
  return <StateShell icon={<Inbox className="h-8 w-8" />} {...props} />;
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  correlationId,
  children,
  headingLevel,
}: {
  title?: string;
  description?: string;
  correlationId?: string;
  children?: ReactNode;
  headingLevel?: HeadingLevel;
}) {
  return (
    <StateShell
      icon={<AlertTriangle className="h-8 w-8" />}
      title={title}
      description={description}
      headingLevel={headingLevel}
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
