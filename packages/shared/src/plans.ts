import { z } from 'zod';

export const PLAN_TIERS = ['FREE', 'PRO', 'TEAM'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];
export const planTierSchema = z.enum(PLAN_TIERS);

export interface PlanLimits {
  maxMembers: number;
  /** `null` = unlimited. */
  maxDocuments: number | null;
  maxStorageBytes: number;
  /** Monthly price in US cents. */
  priceCents: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Plan limits (decision D13). Members count accepted members plus pending invites; document guests do not count. */
export const PLAN_CATALOG: Record<PlanTier, PlanLimits> = {
  FREE: { maxMembers: 3, maxDocuments: 20, maxStorageBytes: 100 * MB, priceCents: 0 },
  PRO: { maxMembers: 10, maxDocuments: 500, maxStorageBytes: 5 * GB, priceCents: 1200 },
  TEAM: { maxMembers: 50, maxDocuments: null, maxStorageBytes: 50 * GB, priceCents: 4900 },
};

export type LimitKind = 'members' | 'documents' | 'storage';

export function limitFor(plan: PlanTier, kind: LimitKind): number | null {
  const limits = PLAN_CATALOG[plan];
  switch (kind) {
    case 'members':
      return limits.maxMembers;
    case 'documents':
      return limits.maxDocuments;
    case 'storage':
      return limits.maxStorageBytes;
  }
}

/** True when `addBytes` more storage still fits the plan (the limit itself is allowed). */
export function storageFits(plan: PlanTier, currentBytes: number, addBytes: number): boolean {
  return currentBytes + addBytes <= PLAN_CATALOG[plan].maxStorageBytes;
}
