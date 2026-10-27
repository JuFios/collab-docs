/**
 * "Pay and re-send webhook" exists to show the idempotency of the webhook during a demo. It is a development aid and
 * is not offered in staging (the same rule as the dashboard test delay).
 */
export function redeliverEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.APP_ENV !== 'staging';
}
