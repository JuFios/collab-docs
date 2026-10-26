import { Test } from '@nestjs/testing';
import { PrismaClient } from '@collab-docs/db';
import { PLAN_CATALOG, type PlanTier } from '@collab-docs/shared';
import { PlanLimitsService, type Tx } from './plan-limits.service';

/** The few Prisma operations the service reads; the same object serves as the client and as the transaction. */
function fakeDb(plan: PlanTier | null = 'FREE') {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'ws' }]),
    subscription: {
      findUnique: jest.fn().mockResolvedValue(plan ? { plan } : null),
    },
    workspaceMember: { count: jest.fn().mockResolvedValue(0) },
    workspaceInvite: { count: jest.fn().mockResolvedValue(0) },
    document: { count: jest.fn().mockResolvedValue(0) },
    attachment: { aggregate: jest.fn().mockResolvedValue({ _sum: { size: null } }) },
  };
}

async function setup(plan: PlanTier | null = 'FREE') {
  const db = fakeDb(plan);
  const moduleRef = await Test.createTestingModule({
    providers: [PlanLimitsService, { provide: PrismaClient, useValue: db }],
  }).compile();
  return { db, service: moduleRef.get(PlanLimitsService), tx: db as unknown as Tx };
}

const WORKSPACE = '0190b1c2-0000-7000-8000-0000000000aa';

describe('PlanLimitsService', () => {
  describe('lockWorkspace', () => {
    it('locks the workspace row', async () => {
      const { service, tx, db } = await setup();
      await expect(service.lockWorkspace(tx, WORKSPACE)).resolves.toBeUndefined();
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('answers NOT_FOUND when the workspace is gone', async () => {
      const { service, tx, db } = await setup();
      db.$queryRaw.mockResolvedValue([]);
      await expect(service.lockWorkspace(tx, WORKSPACE)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('planOf', () => {
    it('is FREE without a subscription', async () => {
      const { service, tx } = await setup(null);
      await expect(service.planOf(tx, WORKSPACE)).resolves.toBe('FREE');
    });

    it('returns the subscribed plan', async () => {
      const { service, tx } = await setup('PRO');
      await expect(service.planOf(tx, WORKSPACE)).resolves.toBe('PRO');
    });
  });

  describe('members', () => {
    it('counts accepted members plus live pending invites, never document guests', async () => {
      const { service, tx, db } = await setup();
      db.workspaceMember.count.mockResolvedValue(2);
      db.workspaceInvite.count.mockResolvedValue(1);

      await expect(service.countMemberSlots(tx, WORKSPACE)).resolves.toEqual({
        members: 2,
        pendingInvites: 1,
      });
      expect(db.workspaceInvite.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          workspaceId: WORKSPACE,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
        }),
      });
    });

    it('leaves out the invite or the e-mail being replaced', async () => {
      const { service, tx, db } = await setup();
      await service.countMemberSlots(tx, WORKSPACE, {
        excludeInviteId: 'invite-1',
        excludeEmail: 'ada@example.test',
      });
      expect(db.workspaceInvite.count.mock.calls[0]![0].where).toMatchObject({
        id: { not: 'invite-1' },
        email: { not: 'ada@example.test' },
      });
    });

    it('lets the last free slot be taken and refuses the next one', async () => {
      const { service, tx, db } = await setup('FREE');
      const limit = PLAN_CATALOG.FREE.maxMembers;
      db.workspaceMember.count.mockResolvedValue(limit - 2);
      db.workspaceInvite.count.mockResolvedValue(1);
      await expect(service.assertCanAddMember(tx, WORKSPACE)).resolves.toBeUndefined();

      db.workspaceInvite.count.mockResolvedValue(2);
      await expect(service.assertCanAddMember(tx, WORKSPACE)).rejects.toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { kind: 'members', limit, current: limit, plan: 'FREE' },
      });
    });

    it('uses the limit of the subscribed plan', async () => {
      const { service, tx, db } = await setup('PRO');
      db.workspaceMember.count.mockResolvedValue(PLAN_CATALOG.FREE.maxMembers);
      await expect(service.assertCanAddMember(tx, WORKSPACE)).resolves.toBeUndefined();
    });
  });

  describe('documents', () => {
    it('refuses a document beyond the limit and reports the counts', async () => {
      const { service, tx, db } = await setup('FREE');
      const limit = PLAN_CATALOG.FREE.maxDocuments!;
      db.document.count.mockResolvedValue(limit);
      await expect(service.assertCanAddDocument(tx, WORKSPACE)).rejects.toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { kind: 'documents', limit, current: limit, plan: 'FREE' },
      });
    });

    it('checks a whole batch against the remaining room', async () => {
      const { service, tx, db } = await setup('FREE');
      const limit = PLAN_CATALOG.FREE.maxDocuments!;
      db.document.count.mockResolvedValue(limit - 3);
      await expect(service.assertCanAddDocument(tx, WORKSPACE, 3)).resolves.toBeUndefined();
      await expect(service.assertCanAddDocument(tx, WORKSPACE, 4)).rejects.toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
      });
    });

    it('does not count anything on a plan without a document limit', async () => {
      const { service, tx, db } = await setup('TEAM');
      await expect(service.assertCanAddDocument(tx, WORKSPACE, 1000)).resolves.toBeUndefined();
      expect(db.document.count).not.toHaveBeenCalled();
    });
  });

  describe('storage', () => {
    it('sums the attachments of the workspace, uploads in flight included', async () => {
      const { service, tx, db } = await setup();
      expect(await service.storageBytes(tx, WORKSPACE)).toBe(0);
      db.attachment.aggregate.mockResolvedValue({ _sum: { size: 1234 } });
      expect(await service.storageBytes(tx, WORKSPACE)).toBe(1234);
      expect(db.attachment.aggregate).toHaveBeenLastCalledWith({
        where: { workspaceId: WORKSPACE },
        _sum: { size: true },
      });
    });

    it('allows filling the quota exactly and refuses one byte more', async () => {
      const { service, tx, db } = await setup('FREE');
      const limit = PLAN_CATALOG.FREE.maxStorageBytes;
      db.attachment.aggregate.mockResolvedValue({ _sum: { size: limit - 10 } });
      await expect(service.assertCanAddStorage(tx, WORKSPACE, 10)).resolves.toBeUndefined();
      await expect(service.assertCanAddStorage(tx, WORKSPACE, 11)).rejects.toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { kind: 'storage', limit, current: limit - 10, plan: 'FREE' },
      });
    });
  });

  describe('usage', () => {
    it('reports plan, members, documents and storage against the plan limits', async () => {
      const { service, db } = await setup('PRO');
      db.workspaceMember.count.mockResolvedValue(4);
      db.workspaceInvite.count.mockResolvedValue(2);
      db.document.count.mockResolvedValue(30);
      db.attachment.aggregate.mockResolvedValue({ _sum: { size: 2048 } });

      await expect(service.usage(WORKSPACE)).resolves.toEqual({
        plan: 'PRO',
        members: { current: 4, pendingInvites: 2, limit: PLAN_CATALOG.PRO.maxMembers },
        documents: { current: 30, limit: PLAN_CATALOG.PRO.maxDocuments },
        storage: { currentBytes: 2048, limitBytes: PLAN_CATALOG.PRO.maxStorageBytes },
      });
    });

    it('reports a null document limit for the unlimited plan', async () => {
      const { service } = await setup('TEAM');
      expect((await service.usage(WORKSPACE)).documents.limit).toBeNull();
    });
  });
});
