import { createHash, randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@collab-docs/db';
import { REFRESH_TOKEN_TTL_SECONDS } from '@collab-docs/shared';
import { AppException, logEvent, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A just-rotated token may be presented again for this long, by the client that rotated it: parallel requests and
 * several tabs of one browser all hold the old cookie for a moment. The same token from another client, or later,
 * is a stolen copy and revokes the family.
 */
export const REFRESH_GRACE_MS = 10_000;

type RefreshResult =
  /** The presented token was current: it has been rotated, `token` is the replacement. */
  | { kind: 'rotated'; userId: string; token: string }
  /** The presented token was rotated moments ago: only a new access token is warranted. */
  | { kind: 'grace'; userId: string };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The part of an address that stays put while one device is online: the /24 of an IPv4 address and the /64 of an IPv6
 * one (the rest is the host part, which privacy extensions rotate and carrier pools reassign between requests).
 * An address that is neither is kept as it is; an IPv4 address in its IPv6 form (`::ffff:a.b.c.d`) counts as IPv4.
 * The two families are never merged: a browser that reaches the api over both stays two clients.
 */
export function networkOf(ip: string | undefined): string {
  if (!ip) return '';
  const address = ip.toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');
  if (isIPv4(address)) return `${address.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIPv6(address)) {
    const [head = '', tail] = address.split('::');
    const written = head === '' ? [] : head.split(':');
    const after = tail === undefined || tail === '' ? [] : tail.split(':');
    const groups =
      tail === undefined
        ? written
        : [...written, ...Array<string>(8 - written.length - after.length).fill('0'), ...after];
    return `${groups
      .slice(0, 4)
      .map((group) => Number.parseInt(group, 16).toString(16))
      .join(':')}::/64`;
  }
  return address;
}

/**
 * Who presented a token, for the grace window: the SHA-256 of the User-Agent and the network of the client address
 * (the address the api resolves after its trusted proxies). Both can be forged by a thief who knows them, which is
 * why the window is also short; nothing about the client is stored in the clear.
 */
export function clientFingerprint(client: { userAgent?: string; ip?: string }): string {
  return hashToken(`${client.userAgent ?? ''}\n${networkOf(client.ip)}`);
}

/** Opaque 256-bit token; only its SHA-256 is stored. */
function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

const rejected = () => new AppException('UNAUTHENTICATED', 'Invalid or expired session');

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(RefreshTokenService.name) private readonly logger: PinoLogger,
  ) {}

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
  async rotate(presented: string, client: string, now = new Date()): Promise<RefreshResult> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    });
    if (!row || row.revokedAt || row.expiresAt <= now) throw rejected();
    if (row.rotatedAt) return this.reuse(row.id, client, now);

    const next = generateToken();
    const created = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshToken.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, rotatedBy: client },
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
    if (!created) return this.reuse(row.id, client, now); // lost the race to a parallel request
    return { kind: 'rotated', userId: row.userId, token: next.token };
  }

  /** Revokes the whole family of the presented token; unknown tokens are ignored. */
  async revokeFamilyOf(presented: string, now = new Date()): Promise<void> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(presented) },
    });
    if (row) await this.revokeFamily(row.familyId, now);
  }

  /** Revokes every live token of the user, in `db` when the caller is inside a transaction. */
  async revokeAllOf(
    userId: string,
    db: Pick<Prisma.TransactionClient, 'refreshToken'> = this.prisma,
    now = new Date(),
  ): Promise<void> {
    await db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async reuse(id: string, client: string, now: Date): Promise<RefreshResult> {
    const row = await this.prisma.refreshToken.findUnique({ where: { id } });
    if (!row || row.revokedAt || !row.rotatedAt) throw rejected();
    const inWindow = now.getTime() - row.rotatedAt.getTime() <= REFRESH_GRACE_MS;
    const sameClient = row.rotatedBy === client;
    if (inWindow && sameClient) return { kind: 'grace', userId: row.userId };
    await this.revokeFamily(row.familyId, now);
    logEvent(this.logger, 'auth.refresh_reuse_detected', {
      userId: row.userId,
      familyId: row.familyId,
      reason: inWindow ? 'other_client' : 'after_grace',
    });
    throw rejected();
  }

  private async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
