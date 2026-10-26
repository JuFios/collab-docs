import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@collab-docs/db';
import { REFRESH_TOKEN_TTL_SECONDS } from '@collab-docs/shared';
import { AppException, logEvent } from '@collab-docs/nest';

/** A just-rotated token may be presented again for this long (parallel requests, several tabs). */
export const REFRESH_GRACE_MS = 30_000;

export type RefreshResult =
  /** The presented token was current: it has been rotated, `token` is the replacement. */
  | { kind: 'rotated'; userId: string; token: string }
  /** The presented token was rotated moments ago: only a new access token is warranted. */
  | { kind: 'grace'; userId: string };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Opaque 256-bit token; only its SHA-256 is stored. */
function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

const rejected = () => new AppException('UNAUTHENTICATED', 'Invalid or expired session');

@Injectable()
export class RefreshTokenService {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  /** Starts a new token family (login / register). */
  async issue(userId: string, now = new Date()): Promise<string> {
    const { token, hash } = generateToken();
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId: crypto.randomUUID(),
        tokenHash: hash,
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      },
    });
    return token;
  }

  /**
   * Exchanges a refresh token. Concurrency: the `rotated_at IS NULL` claim is a single conditional UPDATE,
   * so of two parallel requests with the same token exactly one rotates; the other lands in the grace branch.
   */
  async rotate(presented: string, now = new Date()): Promise<RefreshResult> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    });
    if (!row || row.revokedAt || row.expiresAt <= now) throw rejected();
    if (row.rotatedAt) return this.reuse(row.id, now);

    const next = generateToken();
    const created = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now },
      });
      if (claimed.count === 0) return null;
      const replacement = await tx.refreshToken.create({
        data: {
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: next.hash,
          expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
        },
      });
      await tx.refreshToken.update({ where: { id: row.id }, data: { replacedBy: replacement.id } });
      return replacement;
    });
    if (!created) return this.reuse(row.id, now); // lost the race to a parallel request
    return { kind: 'rotated', userId: row.userId, token: next.token };
  }

  /** Revokes the whole family of the presented token; unknown tokens are ignored. */
  async revokeFamilyOf(presented: string, now = new Date()): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    });
    if (row) await this.revokeFamily(row.familyId, now);
  }

  private async reuse(id: string, now: Date): Promise<RefreshResult> {
    const row = await this.prisma.refreshToken.findUnique({ where: { id } });
    if (!row || row.revokedAt || !row.rotatedAt) throw rejected();
    if (now.getTime() - row.rotatedAt.getTime() <= REFRESH_GRACE_MS) {
      return { kind: 'grace', userId: row.userId };
    }
    await this.revokeFamily(row.familyId, now);
    logEvent('auth.refresh_reuse_detected', { userId: row.userId, familyId: row.familyId });
    throw rejected();
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
