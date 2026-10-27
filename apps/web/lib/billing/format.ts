import type { LimitKind, PlanTier } from '@collab-docs/shared';
import { formatBytes } from '@/lib/workspaces/labels';

export const PLAN_LABELS: Record<PlanTier, string> = { FREE: 'Free', PRO: 'Pro', TEAM: 'Team' };

export const LIMIT_LABELS: Record<LimitKind, string> = {
  members: 'Members',
  documents: 'Documents',
  storage: 'Storage',
};

export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** A usage figure as text: bytes for storage, plain counts for the rest. */
export function formatFigure(kind: LimitKind, value: number): string {
  return kind === 'storage' ? formatBytes(value) : value.toLocaleString('en-US');
}

export type UsageTone = 'ok' | 'warning' | 'full';

/** Share of the limit that is used, 0..1; `null` for an unlimited figure. */
export function usageRatio(current: number, limit: number | null): number | null {
  if (limit === null) return null;
  if (limit <= 0) return 1;
  return Math.min(current / limit, 1);
}

/** Warns from 80%, as the plan asks; at the limit the next create is refused. */
export function usageTone(current: number, limit: number | null): UsageTone {
  const ratio = usageRatio(current, limit);
  if (ratio === null) return 'ok';
  if (ratio >= 1) return 'full';
  return ratio >= 0.8 ? 'warning' : 'ok';
}
