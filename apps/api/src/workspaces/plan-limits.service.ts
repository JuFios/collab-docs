import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@collab-docs/db';
import {
  type LimitKind,
  type PlanTier,
  PLAN_CATALOG,
  limitFor,
  storageFits,
} from '@collab-docs/shared';
import { AppException } from '@collab-docs/shared/nest';

export type Tx = Prisma.TransactionClient;

export interface Usage {
  plan: PlanTier;
  members: { current: number; pendingInvites: number; limit: number };
  documents: { current: number; limit: number | null };
  storage: { currentBytes: number; limitBytes: number };
}

/**
 * Plan limit checks (spec §3, §8). Callers run inside a transaction that first takes the workspace row lock
 * (`lockWorkspace`), so concurrent additions serialise and the count they read is current.
 */
@Injectable()
export class PlanLimitsService {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /** `SELECT ... FOR UPDATE` on the workspace row; blocks until concurrent holders commit. */
  async lockWorkspace(tx: Tx, workspaceId: string): Promise<void> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new AppException('NOT_FOUND', 'Workspace not found');
  }

  async planOf(tx: Tx | PrismaClient, workspaceId: string): Promise<PlanTier> {
    const subscription = await tx.subscription.findUnique({
      where: { workspaceId },
      select: { plan: true },
    });
    return subscription?.plan ?? 'FREE';
  }

  /** Accepted members plus pending (not accepted, not revoked, not expired) invites. Document guests never count. */
  async countMemberSlots(
    tx: Tx | PrismaClient,
    workspaceId: string,
    options: { excludeInviteId?: string; excludeEmail?: string } = {},
  ): Promise<{ members: number; pendingInvites: number }> {
    const [members, pendingInvites] = await Promise.all([
      tx.workspaceMember.count({ where: { workspaceId } }),
      tx.workspaceInvite.count({
        where: {
          workspaceId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          ...(options.excludeInviteId ? { id: { not: options.excludeInviteId } } : {}),
          ...(options.excludeEmail ? { email: { not: options.excludeEmail } } : {}),
        },
      }),
    ]);
    return { members, pendingInvites };
  }

  /**
   * Throws `403 PLAN_LIMIT_EXCEEDED` when one more member (or pending invite) would not fit.
   * Must run after `lockWorkspace` in the same transaction.
   */
  async assertCanAddMember(
    tx: Tx,
    workspaceId: string,
    options: { excludeInviteId?: string; excludeEmail?: string } = {},
  ): Promise<void> {
    const plan = await this.planOf(tx, workspaceId);
    const { members, pendingInvites } = await this.countMemberSlots(tx, workspaceId, options);
    const current = members + pendingInvites;
    const limit = PLAN_CATALOG[plan].maxMembers;
    if (current + 1 > limit) throw this.exceeded('members', limit, current, plan);
  }

  /**
   * Throws `403 PLAN_LIMIT_EXCEEDED` when `count` more live documents would not fit (Team: unlimited).
   * Must run after `lockWorkspace` in the same transaction.
   */
  async assertCanAddDocument(tx: Tx, workspaceId: string, count = 1): Promise<void> {
    const plan = await this.planOf(tx, workspaceId);
    const limit = limitFor(plan, 'documents');
    if (limit === null) return;
    const current = await tx.document.count({ where: { workspaceId, deletedAt: null } });
    if (current + count > limit) throw this.exceeded('documents', limit, current, plan);
  }

  /** Bytes held by the workspace's attachments, uploads still in flight included (their size is reserved). */
  async storageBytes(tx: Tx | PrismaClient, workspaceId: string): Promise<number> {
    const { _sum } = await tx.attachment.aggregate({
      where: { workspaceId },
      _sum: { size: true },
    });
    return _sum.size ?? 0;
  }

  /**
   * Throws `403 PLAN_LIMIT_EXCEEDED` (`kind: 'storage'`) when `bytes` more would not fit.
   * Must run after `lockWorkspace` in the same transaction.
   */
  async assertCanAddStorage(tx: Tx, workspaceId: string, bytes: number): Promise<void> {
    const plan = await this.planOf(tx, workspaceId);
    const current = await this.storageBytes(tx, workspaceId);
    if (!storageFits(plan, current, bytes)) {
      throw this.exceeded('storage', PLAN_CATALOG[plan].maxStorageBytes, current, plan);
    }
  }

  exceeded(kind: LimitKind, limit: number, current: number, plan: PlanTier): AppException {
    return new AppException(
      'PLAN_LIMIT_EXCEEDED',
      `The ${plan} plan allows at most ${limit} ${kind}`,
      {
        details: { kind, limit, current, plan },
      },
    );
  }

  async usage(workspaceId: string): Promise<Usage> {
    const plan = await this.planOf(this.prisma, workspaceId);
    const [slots, documents, storageBytes] = await Promise.all([
      this.countMemberSlots(this.prisma, workspaceId),
      this.prisma.document.count({ where: { workspaceId, deletedAt: null } }),
      this.storageBytes(this.prisma, workspaceId),
    ]);
    return {
      plan,
      members: {
        current: slots.members,
        pendingInvites: slots.pendingInvites,
        limit: limitFor(plan, 'members') as number,
      },
      documents: { current: documents, limit: limitFor(plan, 'documents') },
      storage: { currentBytes: storageBytes, limitBytes: limitFor(plan, 'storage') as number },
    };
  }
}
