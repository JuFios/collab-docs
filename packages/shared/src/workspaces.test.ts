import { describe, expect, it } from 'vitest';
import {
  INVITABLE_ROLES,
  createWorkspaceInputSchema,
  inviteInputSchema,
  planLimitDetailsSchema,
} from './workspaces';

describe('workspace form schemas', () => {
  it('trims the name and rejects empty or over-long ones', () => {
    expect(createWorkspaceInputSchema.parse({ name: '  Acme  ' }).name).toBe('Acme');
    expect(createWorkspaceInputSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createWorkspaceInputSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
  });

  it('normalises the invite email and never accepts OWNER', () => {
    expect(inviteInputSchema.parse({ email: ' Grace@Example.COM ', role: 'EDITOR' })).toEqual({
      email: 'grace@example.com',
      role: 'EDITOR',
    });
    expect(inviteInputSchema.safeParse({ email: 'nope', role: 'EDITOR' }).success).toBe(false);
    expect(inviteInputSchema.safeParse({ email: 'a@b.co', role: 'OWNER' }).success).toBe(false);
    expect(INVITABLE_ROLES).toEqual(['ADMIN', 'EDITOR', 'VIEWER']);
  });

  it('reads the details of a plan limit error', () => {
    expect(
      planLimitDetailsSchema.parse({ kind: 'members', limit: 3, current: 3, plan: 'FREE' }),
    ).toMatchObject({ kind: 'members', limit: 3 });
    expect(planLimitDetailsSchema.safeParse({ kind: 'other' }).success).toBe(false);
  });
});
