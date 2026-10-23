import { randomBytes } from 'node:crypto';
import type { Document, PrismaClient, User, Workspace, WorkspaceMember } from '../index';
import { WorkspaceRole } from '../index';

const unique = (): string => randomBytes(4).toString('hex');

export function makeUser(
  prisma: PrismaClient,
  overrides: Partial<Pick<User, 'email' | 'name' | 'passwordHash'>> = {},
): Promise<User> {
  const id = unique();
  return prisma.user.create({
    data: {
      email: `user-${id}@example.test`,
      name: `User ${id}`,
      passwordHash: 'test-password-hash',
      ...overrides,
    },
  });
}

/** Creates a workspace with its owner (a new user unless `owner` is given), an OWNER membership and a FREE subscription. */
export async function makeWorkspace(
  prisma: PrismaClient,
  overrides: { owner?: User; name?: string; slug?: string } = {},
): Promise<{ workspace: Workspace; owner: User; membership: WorkspaceMember }> {
  const owner = overrides.owner ?? (await makeUser(prisma));
  const id = unique();
  const workspace = await prisma.workspace.create({
    data: {
      name: overrides.name ?? `Workspace ${id}`,
      slug: overrides.slug ?? `ws-${id}`,
      ownerId: owner.id,
      subscription: { create: {} },
    },
  });
  const membership = await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: owner.id, role: WorkspaceRole.OWNER },
  });
  return { workspace, owner, membership };
}

export function makeDocument(
  prisma: PrismaClient,
  params: {
    workspaceId: string;
    createdBy: string;
    parentId?: string | null;
    position?: string;
    title?: string;
    deletedAt?: Date | null;
  },
): Promise<Document> {
  return prisma.document.create({
    data: {
      workspaceId: params.workspaceId,
      createdBy: params.createdBy,
      parentId: params.parentId ?? null,
      position: params.position ?? 'a0',
      title: params.title ?? `Document ${unique()}`,
      deletedAt: params.deletedAt ?? null,
    },
  });
}
