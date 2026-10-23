import { describe, expect, it } from 'vitest';
import { dashboardDelayMs } from './dashboard-delay';

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;

describe('dashboardDelayMs', () => {
  it('is off by default and for junk values', () => {
    expect(dashboardDelayMs(env({}))).toBe(0);
    expect(dashboardDelayMs(env({ DASHBOARD_BLOCK_DELAY_MS: 'abc' }))).toBe(0);
    expect(dashboardDelayMs(env({ DASHBOARD_BLOCK_DELAY_MS: '-5' }))).toBe(0);
  });

  it('applies the configured delay, capped', () => {
    expect(dashboardDelayMs(env({ DASHBOARD_BLOCK_DELAY_MS: '400' }))).toBe(400);
    expect(dashboardDelayMs(env({ DASHBOARD_BLOCK_DELAY_MS: '999999' }))).toBe(5000);
  });

  it('is never honoured in staging', () => {
    expect(dashboardDelayMs(env({ APP_ENV: 'staging', DASHBOARD_BLOCK_DELAY_MS: '400' }))).toBe(0);
  });
});
