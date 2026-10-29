// Development seed. Idempotent: safe to run repeatedly. Refuses to run outside APP_ENV=dev.
import { hash } from '@node-rs/argon2';
import { createPrismaClient, DocumentVisibility, WorkspaceRole } from '../src/index';

const DEV_PASSWORD = 'password123'; // seeded users only; never use outside local development

const USERS = [
  { email: 'alice@example.test', name: 'Alice', role: WorkspaceRole.OWNER },
  { email: 'bob@example.test', name: 'Bob', role: WorkspaceRole.EDITOR },
  { email: 'carol@example.test', name: 'Carol', role: WorkspaceRole.VIEWER },
] as const;

// [title, parent title or null, fractional position]
const DOCUMENTS: ReadonlyArray<readonly [string, string | null, string]> = [
  ['Welcome', null, 'a0'],
  ['Engineering', null, 'a1'],
  ['Architecture', 'Engineering', 'a0'],
  ['Runbooks', 'Engineering', 'a1'],
  ['Meeting notes', null, 'a2'],
];

async function main(): Promise<void> {
  if ((process.env.APP_ENV ?? 'dev') !== 'dev') {
    process.stdout.write('seed skipped: APP_ENV is not "dev"\n');
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const prisma = createPrismaClient(url);
  try {
    const passwordHash = await hash(DEV_PASSWORD);
    const users = new Map<string, string>();
    for (const u of USERS) {
      const user = await prisma.user.upsert({
        where: { email: u.email },
        update: {},
        create: { email: u.email, name: u.name, passwordHash, emailVerifiedAt: new Date() },
      });
      users.set(u.email, user.id);
    }
    const aliceId = users.get('alice@example.test') as string;

    const workspace = await prisma.workspace.upsert({
      where: { slug: 'acme' },
      update: {},
      create: { name: 'Acme', slug: 'acme', ownerId: aliceId, subscription: { create: {} } },
    });
    for (const u of USERS) {
      const userId = users.get(u.email) as string;
      await prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
        update: {},
        create: { workspaceId: workspace.id, userId, role: u.role },
      });
    }

    const ids = new Map<string, string>();
    for (const [title, parentTitle, position] of DOCUMENTS) {
      const parentId = parentTitle ? (ids.get(parentTitle) ?? null) : null;
      const existing = await prisma.document.findFirst({
        where: { workspaceId: workspace.id, title, parentId },
      });
      const doc =
        existing ??
        (await prisma.document.create({
          data: {
            workspaceId: workspace.id,
            title,
            parentId,
            position,
            visibility: DocumentVisibility.WORKSPACE,
            createdBy: aliceId,
          },
        }));
      ids.set(title, doc.id);
    }
    process.stdout.write(
      `seeded workspace "${workspace.slug}" with ${USERS.length} users and ${DOCUMENTS.length} documents\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed failed: ${String(error)}\n`);
  process.exit(1);
});
