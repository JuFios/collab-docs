import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@collab-docs/db';
import type { PlanTier, WorkspaceRole } from '@collab-docs/shared';
import { AppException, logEvent } from '@collab-docs/nest';
import { notFound } from '../permissions/permissions.service';
import { type Usage, PlanLimitsService } from './plan-limits.service';
import { generateSlug } from './slug';
import type { WorkspaceResponse } from './workspaces.dto';

type WorkspaceWithPlan = Prisma.WorkspaceGetPayload<{ include: { subscription: true } }>;

function toResponse(workspace: WorkspaceWithPlan, role: WorkspaceRole): WorkspaceResponse {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    role,
    plan: workspace.subscription?.plan ?? 'FREE',
    createdAt: workspace.createdAt.toISOString(),
  };
}

const SLUG_ATTEMPTS = 3;

@Injectable()
export class WorkspacesService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(PlanLimitsService) private readonly limits: PlanLimitsService,
  ) {}

  /** The creator becomes OWNER and the workspace starts on the FREE plan. */
  async create(userId: string, name: string): Promise<WorkspaceResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        const workspace = await this.prisma.$transaction(async (tx) => {
          const created = await tx.workspace.create({
            data: {
              name,
              slug: generateSlug(name),
              ownerId: userId,
              subscription: { create: { plan: 'FREE' as PlanTier } },
              members: { create: { userId, role: 'OWNER' } },
            },
            include: { subscription: true },
          });
          return created;
        });
        logEvent('workspace.created', { workspaceId: workspace.id, userId });
        return toResponse(workspace, 'OWNER');
      } catch (error) {
        const slugClash =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          attempt < SLUG_ATTEMPTS;
        if (!slugClash) throw error;
      }
    }
  }

  async listForUser(userId: string): Promise<WorkspaceResponse[]> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: { include: { subscription: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => toResponse(m.workspace, m.role));
  }

  async get(workspaceId: string, role: WorkspaceRole): Promise<WorkspaceResponse> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { subscription: true },
    });
    if (!workspace) throw notFound('Workspace');
    return toResponse(workspace, role);
  }

  async rename(workspaceId: string, role: WorkspaceRole, name: string): Promise<WorkspaceResponse> {
    try {
      const workspace = await this.prisma.workspace.update({
        where: { id: workspaceId },
        data: { name },
        include: { subscription: true },
      });
      return toResponse(workspace, role);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new AppException('NOT_FOUND', 'Workspace not found');
      }
      throw error;
    }
  }

  usage(workspaceId: string): Promise<Usage> {
    return this.limits.usage(workspaceId);
  }
}
