import type { PrismaClient } from '@collab-docs/db';

/**
 * What following the link in the confirmation email does. Suites that are not about confirmation start with
 * confirmed accounts, so that documents can be shared with them; `auth.int.spec.ts` covers the link itself.
 */
export async function confirmEmail(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
}
