import type { LimitKind } from '@collab-docs/shared';
import {
  LIMIT_LABELS,
  type UsageTone,
  formatFigure,
  usageRatio,
  usageTone,
} from '@/lib/billing/format';
import { cn } from '@/lib/utils';

const BAR: Record<UsageTone, string> = {
  ok: 'bg-primary',
  warning: 'bg-amber-500',
  full: 'bg-destructive',
};

/** One figure against its limit; amber from 80%, red at the limit. An unlimited figure has no bar. */
export function UsageMeter({
  kind,
  current,
  limit,
}: {
  kind: LimitKind;
  current: number;
  limit: number | null;
}) {
  const ratio = usageRatio(current, limit);
  const tone = usageTone(current, limit);
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{LIMIT_LABELS[kind]}</span>
        <span className="text-muted-foreground">
          {formatFigure(kind, current)} of{' '}
          {limit === null ? 'unlimited' : formatFigure(kind, limit)}
        </span>
      </div>
      {ratio === null || limit === null ? null : (
        <div
          role="progressbar"
          aria-label={`${LIMIT_LABELS[kind]} used`}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(current, limit)}
          aria-valuetext={`${formatFigure(kind, current)} of ${formatFigure(kind, limit)}`}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn('h-full rounded-full', BAR[tone])}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      )}
      {tone === 'warning' ? (
        <p className="text-xs text-muted-foreground">Almost at the limit.</p>
      ) : null}
      {tone === 'full' ? <p className="text-xs text-destructive">Limit reached.</p> : null}
    </div>
  );
}
