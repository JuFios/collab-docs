import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TONES = {
  info: { icon: Info, className: 'border-border bg-muted text-foreground' },
  warning: {
    icon: AlertTriangle,
    className: 'border-amber-500/40 bg-amber-500/10 text-foreground',
  },
  error: {
    icon: AlertTriangle,
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
  success: {
    icon: CheckCircle2,
    className: 'border-emerald-600/30 bg-emerald-600/10 text-foreground',
  },
} as const;

/** A banner for the state of the subscription. Errors are announced at once, the rest politely. */
export function Notice({
  tone,
  title,
  children,
}: {
  tone: keyof typeof TONES;
  title: string;
  children?: ReactNode;
}) {
  const { icon: Icon, className } = TONES[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', className)}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="grid gap-1">
        <p className="font-medium">{title}</p>
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}
