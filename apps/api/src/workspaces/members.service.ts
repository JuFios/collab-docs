import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@collab-docs/db';
import {
  type MemberRuleViolation,
  type WorkspaceRole,
  checkMemberRemoval,
  checkRoleChange,
} from '@collab-docs/shared';
import { AppException, logEvent } from '@collab-docs/nest';
import { PermEventsService } from '../permissions/perm-events.service';
import { notFound } from '../permissions/permissions.service';
import { PlanLimitsService, type Tx } from './plan-limits.service';
import type { MemberResponse } from './workspaces.dto';

function violation(rule: MemberRuleViolation): AppException {
  switch (rule) {
    case 'LAST_OWNER':
      return new AppException('CONFLICT', 'A workspace must keep at least one owner');
    case 'CANNOT_MODIFY_OWNER':
      return new AppException('FORBIDDEN', 'Only an owner can change or remove an owner');
    case 'CANNOT_GRANT_OWNER':
      return new AppException('FORBIDDEN', 'Only an owner can grant the owner role');
    case 'ACTOR_NOT_PERMITTED':
      return new AppException('FORBIDDEN', 'You do not have permission to do this');
  }
}

@Injectable()
export class MembersService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(PlanLimitsService) private readonly limits: PlanLimitsService,
    @Inject(PermEventsService) private readonly events: PermEventsService,
  ) {}

  async list(workspaceId: string): Promise<MemberResponse[]> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /** The guard read the actor's role before the lock; a concurrent change may have altered it since. */
  private async currentRole(tx: Tx, workspaceId: string, userId: string): Promise<WorkspaceRole> {
    const actor = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!actor) throw notFound('Workspace');
    return actor.role;
  }

  async changeRole(
    workspaceId: string,
    actor: { id: string },
    targetUserId: string,
    newRole: WorkspaceRole,
  ): Promise<MemberResponse> {
    const updated = await this.prisma.$transaction(async (tx) => {
      // serialises with other role changes/removals so the "last owner" check cannot be raced
      await this.limits.lockWorkspace(tx, workspaceId);
      const target = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      if (!target) throw notFound('Member');
      const actorRole = await this.currentRole(tx, workspaceId, actor.id);
      const owners = await tx.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
      const rule = checkRoleChange({
        actorRole,
        targetRole: target.role,
        newRole,
        targetIsLastOwner: target.role === 'OWNER' && owners <= 1,
      });
      if (rule) throw violation(rule);
      return {
        previousRole: target.role,
        member: await tx.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
          data: { role: newRole },
          include: { user: { select: { name: true, email: true } } },
        }),
      };
    });
    if (updated.previousRole !== newRole) {
      logEvent('member.role_changed', {
        workspaceId,
        actorId: actor.id,
        userId: targetUserId,
        from: updated.previousRole,
        to: newRole,
      });
      await this.events.permChanged({ workspaceId, userId: targetUserId, reason: 'role_changed' });
    }
    const m = updated.member;
    return {
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    };
  }

  /** Removes a member, or lets the caller leave when `targetUserId` is themselves. */
  async remove(workspaceId: string, actor: { id: string }, targetUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.limits.lockWorkspace(tx, workspaceId);
      const target = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      if (!target) throw notFound('Member');
      const actorRole = await this.currentRole(tx, workspaceId, actor.id);
      const owners = await tx.workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
      const rule = checkMemberRemoval({
        actorRole,
        targetRole: target.role,
        self: actor.id === targetUserId,
        targetIsLastOwner: target.role === 'OWNER' && owners <= 1,
      });
      if (rule) throw violation(rule);
      await tx.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
    });
    logEvent('member.removed', { workspaceId, actorId: actor.id, userId: targetUserId });
    await this.events.permChanged({ workspaceId, userId: targetUserId, reason: 'member_removed' });
  }
}
