const MAX_DELAY_MS = 5_000;

/**
 * Artificial latency for the dashboard blocks, used by the streaming test to tell "skeleton first" from
 * "everything at once". Off unless `DASHBOARD_BLOCK_DELAY_MS` is set, and never honoured in staging.
 */
export function dashboardDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.APP_ENV === 'staging') return 0;
  const value = Number(env.DASHBOARD_BLOCK_DELAY_MS);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_DELAY_MS) : 0;
}

export async function dashboardDelay(): Promise<void> {
  const ms = dashboardDelayMs();
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}
