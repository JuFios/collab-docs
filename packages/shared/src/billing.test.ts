import { describe, expect, it } from 'vitest';
import {
  BILLING_EVENT_TYPES,
  billingEventSchema,
  checkoutEventDataSchema,
  createCheckoutInputSchema,
  overLimit,
  planCatalogList,
} from './billing';
import { PLAN_CATALOG } from './plans';

describe('createCheckoutInputSchema', () => {
  it.each(['PRO', 'TEAM'])('accepts %s', (plan) => {
    expect(createCheckoutInputSchema.safeParse({ plan }).success).toBe(true);
  });

  it.each(['FREE', 'pro', '', 1, null])('refuses %j', (plan) => {
    expect(createCheckoutInputSchema.safeParse({ plan }).success).toBe(false);
  });
});

describe('billingEventSchema', () => {
  const event = {
    id: `evt_${'a'.repeat(32)}`,
    type: BILLING_EVENT_TYPES.checkoutCompleted,
    created: 1_790_000_000_000,
    data: { checkoutSessionId: '0190b1c2-0000-7000-8000-0000000000aa' },
  };

  it('accepts a provider event', () => {
    expect(billingEventSchema.safeParse(event).success).toBe(true);
  });

  it.each([
    ['an id that is not evt_<32 hex>', { id: 'evt_1' }],
    ['a fractional timestamp', { created: 1.5 }],
    ['a missing type', { type: '' }],
    ['non-object data', { data: 'x' }],
  ])('refuses %s', (_name, patch) => {
    expect(billingEventSchema.safeParse({ ...event, ...patch }).success).toBe(false);
  });

  it('checks the data of a checkout event separately', () => {
    expect(checkoutEventDataSchema.safeParse(event.data).success).toBe(true);
    expect(checkoutEventDataSchema.safeParse({ checkoutSessionId: 'x' }).success).toBe(false);
  });
});

describe('planCatalogList', () => {
  it('lists every plan with its limits and price', () => {
    expect(planCatalogList().map((plan) => plan.plan)).toEqual(['FREE', 'PRO', 'TEAM']);
    expect(planCatalogList()[1]).toEqual({
      plan: 'PRO',
      priceCents: PLAN_CATALOG.PRO.priceCents,
      maxMembers: PLAN_CATALOG.PRO.maxMembers,
      maxDocuments: PLAN_CATALOG.PRO.maxDocuments,
      maxStorageBytes: PLAN_CATALOG.PRO.maxStorageBytes,
    });
  });
});

describe('overLimit', () => {
  it('is empty at the limits: the limit itself is allowed', () => {
    expect(
      overLimit('FREE', {
        members: PLAN_CATALOG.FREE.maxMembers,
        documents: PLAN_CATALOG.FREE.maxDocuments!,
        storage: PLAN_CATALOG.FREE.maxStorageBytes,
      }),
    ).toEqual([]);
  });

  it('names every figure above the limit of the plan', () => {
    expect(overLimit('FREE', { members: 5, documents: 25, storage: 10 })).toEqual([
      { kind: 'members', current: 5, limit: 3 },
      { kind: 'documents', current: 25, limit: 20 },
    ]);
  });

  it('never reports documents on the plan without a document limit', () => {
    expect(overLimit('TEAM', { members: 1, documents: 100_000, storage: 0 })).toEqual([]);
  });
});
