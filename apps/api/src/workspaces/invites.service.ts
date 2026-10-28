import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkspaceRole } from '@collab-docs/shared';
import {
  AppException,
  type AppConfig,
  logEvent,
  InjectPinoLogger,
  PinoLogger,
} from '@collab-docs/nest';
import { MailQueueService } from '../mail/mail-queue.service';
import { notFound } from '../permissions/permissions.service';
import { INVITE_TOKEN_PATTERN, INVITE_TTL_MS, hashToken, newInviteToken } from './invite-token';
import { PlanLimitsService } from './plan-limits.service';
import type { AcceptInviteResponse, InvitePreviewResponse, InviteResponse } from './workspaces.dto';
import { PrismaService } from '../prisma/prisma.service';

const invalidInvite = () =>
  new AppException('INVITE_INVALID', 'This invitation is invalid or has expired');

function toResponse(invite: {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: Date;
  createdAt: Date;
  invitedBy: string;
}): InviteResponse {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
    invitedBy: invite.invitedBy,
  };
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limits: PlanLimitsService,
    private readonly mail: MailQueueService,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(InvitesService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Creates an invite, or re-issues the pending one for the same email (new token and expiry, role updated).
   * Plan limit and duplicate checks run under the workspace row lock.
   */
  async create(
    workspaceId: string,
    inviterId: string,
    input: { email: string; role: WorkspaceRole },
  ): Promise<InviteResponse> {
    const { token, hash } = newInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await this.prisma.$transaction(async (tx) => {
      await this.limits.lockWorkspace(tx, workspaceId);

      const existingUser = await tx.user.findUnique({
        where: { email: input.email },
        select: { id: true },
      });
      if (existingUser) {
        const member = await tx.workspaceMember.findUnique({
          where: { workspaceId_userId: { workspaceId, userId: existingUser.id } },
        });
        if (member) throw new AppException('CONFLICT', 'This user is already a member');
      }

      // the invite being re-issued is replaced, so it does not count towards the limit
      await this.limits.assertCanAddMember(tx, workspaceId, { excludeEmail: input.email });

      const pending = await tx.workspaceInvite.findFirst({
        where: { workspaceId, email: input.email, acceptedAt: null, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (pending) {
        return tx.workspaceInvite.update({
          where: { id: pending.id },
          data: { tokenHash: hash, role: input.role, expiresAt, invitedBy: inviterId },
        });
      }
      return tx.workspaceInvite.create({
        data: {
          workspaceId,
          email: input.email,
          role: input.role,
          tokenHash: hash,
          expiresAt,
          invitedBy: inviterId,
        },
      });
    });

    const [workspace, inviter] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { name: true },
      }),
      this.prisma.user.findUniqueOrThrow({ where: { id: inviterId }, select: { name: true } }),
    ]);
    await this.mail.sendInvite({
      to: input.email,
      workspaceName: workspace.name,
      inviterName: inviter.name,
      role: input.role,
      link: new URL(`/invite/${token}`, this.config.get('WEB_ORIGIN', { infer: true })).toString(),
      expiresAt: expiresAt.toISOString(),
    });
    logEvent(this.logger, 'invite.sent', {
      workspaceId,
      inviteId: invite.id,
      inviterId,
      role: input.role,
    });
    return toResponse(invite);
  }

  async list(workspaceId: string): Promise<InviteResponse[]> {
    const invites = await this.prisma.workspaceInvite.findMany({
      where: {
        workspaceId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    return invites.map(toResponse);
  }

  async revoke(workspaceId: string, inviteId: string): Promise<void> {
    const result = await this.prisma.workspaceInvite.updateMany({
      where: { id: inviteId, workspaceId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) throw notFound('Invite');
    logEvent(this.logger, 'invite.revoked', { workspaceId, inviteId });
  }

  /** Public: shows what the token is for, so the web app can route the visitor through login/register. */
  async preview(token: string): Promise<InvitePreviewResponse> {
    const invite = await this.findUsable(token);
    if (!invite) throw invalidInvite();
    return {
      workspaceName: invite.workspace.name,
      email: invite.email,
      role: invite.role,
      inviterName: invite.inviter.name,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  async accept(token: string, userId: string): Promise<AcceptInviteResponse> {
    const invite = await this.findUsable(token);
    if (!invite) throw invalidInvite();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!user) throw new AppException('UNAUTHENTICATED', 'Authentication required');
    if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
      throw new AppException('FORBIDDEN', 'This invitation was sent to a different email address');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.limits.lockWorkspace(tx, invite.workspaceId);
      // single conditional update: of two parallel accepts exactly one claims the invite
      const claimed = await tx.workspaceInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (claimed.count !== 1) throw invalidInvite();

      const existing = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
      });
      if (existing)
        throw new AppException('CONFLICT', 'You are already a member of this workspace');

      // the claimed invite was counted as a pending slot; after a downgrade the workspace may be over its limit
      await this.limits.assertCanAddMember(tx, invite.workspaceId, { excludeInviteId: invite.id });
      await tx.workspaceMember.create({
        data: { workspaceId: invite.workspaceId, userId, role: invite.role },
      });
    });
    logEvent(this.logger, 'invite.accepted', {
      workspaceId: invite.workspaceId,
      inviteId: invite.id,
      userId,
    });
    return { workspaceId: invite.workspaceId, role: invite.role };
  }

  private async findUsable(token: string) {
    if (!INVITE_TOKEN_PATTERN.test(token)) return null;
    return this.prisma.workspaceInvite.findFirst({
      where: {
        tokenHash: hashToken(token),
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { workspace: { select: { name: true } }, inviter: { select: { name: true } } },
    });
  }
}
