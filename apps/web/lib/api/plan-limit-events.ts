/** Raised when a mutation fails with `PLAN_LIMIT_EXCEEDED`; the upgrade dialog (billing UI) subscribes to it. */
const PLAN_LIMIT_EVENT = 'collab-docs:plan-limit-exceeded';

export interface PlanLimitDetail {
  message: string;
  correlationId?: string;
  details?: unknown;
}

export function emitPlanLimitExceeded(detail: PlanLimitDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PlanLimitDetail>(PLAN_LIMIT_EVENT, { detail }));
}

export function onPlanLimitExceeded(listener: (detail: PlanLimitDetail) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<PlanLimitDetail>).detail);
  window.addEventListener(PLAN_LIMIT_EVENT, handler);
  return () => window.removeEventListener(PLAN_LIMIT_EVENT, handler);
}
