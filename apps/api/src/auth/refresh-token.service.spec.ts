import type { PrismaClient } from '@collab-docs/db';
import type { PinoLogger } from '@collab-docs/nest';
import { REFRESH_GRACE_MS, RefreshTokenService, hashToken } from './refresh-token.service';

interface Row {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  replacedBy: string | null;
}

type Where = Partial<Pick<Row, 'id' | 'familyId' | 'tokenHash' | 'rotatedAt' | 'revokedAt'>>;

/** The few `refreshToken` operations the service uses, over an in-memory table. */
function fakePrisma() {
  const rows: Row[] = [];
  const matches = (row: Row, where: Where) =>
    Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
  const refreshToken = {
    create: async ({ data }: { data: Partial<Row> & { userId: string } }) => {
      const row: Row = {
        id: crypto.randomUUID(),
        familyId: crypto.randomUUID(),
        tokenHash: '',
        expiresAt: new Date(),
        rotatedAt: null,
        revokedAt: null,
        replacedBy: null,
        ...data,
      };
      rows.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
    update: async ({ where, data }: { where: Where; data: Partial<Row> }) =>
      Object.assign(
        rows.find((r) => matches(r, where))!,
        data,
      ),
    updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
  const prisma = {
    refreshToken,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({ refreshToken }),
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

const USER = '0190b1c2-0000-7000-8000-000000000001';
const DAY = 24 * 3600 * 1000;

describe('RefreshTokenService', () => {
  const setup = () => {
    const { prisma, rows } = fakePrisma();
    const logger = { info: jest.fn() };
    return {
      service: new RefreshTokenService(prisma, logger as unknown as PinoLogger),
      rows,
      logger,
    };
  };

  it('issues an opaque token and stores only its hash with a 30 day expiry', async () => {
    const { service, rows } = setup();
    const now = new Date('2026-01-01T00:00:00Z');
    const token = await service.issue(USER, now);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashToken(token));
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]!.expiresAt.getTime() - now.getTime()).toBe(30 * DAY);
  });

  it('rotates: marks the old token, links the replacement and stays in the family', async () => {
    const { service, rows } = setup();
    const now = new Date();
    const first = await service.issue(USER, now);
    const result = await service.rotate(first, now);
    expect(result.kind).toBe('rotated');
    if (result.kind !== 'rotated') return;
    expect(result.token).not.toBe(first);
    expect(rows).toHaveLength(2);
    const [old, next] = rows;
    expect(old!.rotatedAt).toEqual(now);
    expect(old!.replacedBy).toBe(next!.id);
    expect(next!.familyId).toBe(old!.familyId);
    expect(next!.tokenHash).toBe(hashToken(result.token));
  });

  it('answers a replay inside the grace window without rotating again', async () => {
    const { service, rows } = setup();
    const now = new Date();
    const first = await service.issue(USER, now);
    await service.rotate(first, now);
    const replay = await service.rotate(first, new Date(now.getTime() + REFRESH_GRACE_MS));
    expect(replay).toEqual({ kind: 'grace', userId: USER });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
  });

  it('revokes the whole family on a replay after the grace window', async () => {
    const { service, rows, logger } = setup();
    const now = new Date();
    const first = await service.issue(USER, now);
    const second = await service.rotate(first, now);
    const late = new Date(now.getTime() + REFRESH_GRACE_MS + 1);
    await expect(service.rotate(first, late)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth.refresh_reuse_detected', userId: USER }),
      'auth.refresh_reuse_detected',
    );
    if (second.kind === 'rotated') {
      await expect(service.rotate(second.token, late)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('does not touch other families when one is revoked', async () => {
    const { service, rows } = setup();
    const now = new Date();
    const mine = await service.issue(USER, now);
    await service.issue(USER, now); // another device
    await service.revokeFamilyOf(mine, now);
    expect(rows.map((r) => r.revokedAt !== null)).toEqual([true, false]);
  });

  it('rejects unknown, revoked and expired tokens', async () => {
    const { service } = setup();
    const now = new Date();
    await expect(service.rotate('unknown', now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const token = await service.issue(USER, now);
    await expect(service.rotate(token, new Date(now.getTime() + 31 * DAY))).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await service.revokeFamilyOf(token, now);
    await expect(service.rotate(token, now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('treats a lost rotation race as a grace replay', async () => {
    const { prisma, rows } = fakePrisma();
    const service = new RefreshTokenService(prisma, { info: jest.fn() } as unknown as PinoLogger);
    const now = new Date();
    const token = await service.issue(USER, now);
    // a parallel request claims the token between our read and our conditional update
    const original = prisma.refreshToken.updateMany.bind(prisma.refreshToken);
    let first = true;
    jest.spyOn(prisma.refreshToken, 'updateMany').mockImplementation(((args: unknown) => {
      if (first) {
        first = false;
        rows[0]!.rotatedAt = now;
      }
      return original(args as never);
    }) as never);
    await expect(service.rotate(token, now)).resolves.toEqual({ kind: 'grace', userId: USER });
    expect(rows).toHaveLength(1);
  });
});
