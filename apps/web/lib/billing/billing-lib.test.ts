import { describe, expect, it } from 'vitest';
import { formatFigure, formatMoney, usageRatio, usageTone } from './format';
import { redeliverEnabled } from './mock-checkout';
import { billingReturnUrl, parseBillingReturn } from './return';

describe('usage tone', () => {
  it.each([
    [0, 20, 'ok'],
    [15, 20, 'ok'],
    [16, 20, 'warning'],
    [19, 20, 'warning'],
    [20, 20, 'full'],
    [25, 20, 'full'],
  ] as const)('%i of %i is %s', (current, limit, tone) => {
    expect(usageTone(current, limit)).toBe(tone);
  });

  it('never warns about an unlimited figure', () => {
    expect(usageTone(10_000, null)).toBe('ok');
    expect(usageRatio(10_000, null)).toBeNull();
  });

  it('caps the bar at the limit', () => {
    expect(usageRatio(30, 20)).toBe(1);
    expect(usageRatio(5, 20)).toBe(0.25);
  });
});

describe('formatting', () => {
  it('shows money in dollars and storage in bytes units', () => {
    expect(formatMoney(1200)).toBe('$12.00');
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatFigure('storage', 100 * 1024 * 1024)).toBe('100 MB');
    expect(formatFigure('documents', 1500)).toBe('1,500');
  });
});

describe('billing return url', () => {
  const WS = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

  it('round-trips the plan the page is waiting for', () => {
    const url = billingReturnUrl(WS, { awaiting: 'PRO' });
    expect(url).toBe(`/workspaces/${WS}/billing?awaiting=PRO`);
    expect(parseBillingReturn(Object.fromEntries(new URL(url, 'http://x').searchParams))).toEqual({
      awaiting: 'PRO',
    });
  });

  it('marks a declined payment and leaves the plain path alone', () => {
    expect(billingReturnUrl(WS, { declined: true })).toBe(
      `/workspaces/${WS}/billing?payment=declined`,
    );
    expect(billingReturnUrl(WS, {})).toBe(`/workspaces/${WS}/billing`);
  });

  it('ignores values that are not plans', () => {
    expect(parseBillingReturn({ awaiting: 'GOLD', payment: 'maybe' })).toEqual({});
    expect(parseBillingReturn({ awaiting: ['TEAM', 'PRO'] })).toEqual({ awaiting: 'TEAM' });
  });
});

describe('redeliverEnabled', () => {
  it('is a development aid: on in dev and test, off in staging', () => {
    expect(redeliverEnabled({ APP_ENV: 'dev' })).toBe(true);
    expect(redeliverEnabled({ APP_ENV: 'test' })).toBe(true);
    expect(redeliverEnabled({})).toBe(true);
    expect(redeliverEnabled({ APP_ENV: 'staging' })).toBe(false);
  });
});
