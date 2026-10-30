import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@collab-docs/db';
import {
  AppException,
  type AppConfig,
  logEvent,
  InjectPinoLogger,
  PinoLogger,
} from '@collab-docs/nest';
import { MailQueueService } from '../mail/mail-queue.service';
import { releasedAddress } from '../mail/released-address';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from './refresh-token.service';

export const EMAIL_VERIFICATION_TTL_MS = 48 * 3600 * 1000;
/** Well-formed tokens are 43 base64url characters (256 bits); anything else cannot match and skips the lookup. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Confirms that the owner of an account also owns its email address. Until then the address cannot be shared
 * with, so registering someone else's address gets nothing that is shared with it. One pending token per account,
 * stored as its SHA-256; the link stays valid until it expires, so opening it twice is not an error.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailQueueService,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(EmailVerificationService.name) private readonly logger: PinoLogger,
  ) {}

  /** Issues a new link (the previous one stops working) and emails it. */
  async send(user: { id: string; email: string; name: string }): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    await this.prisma.emailVerification.upsert({
      where: { userId: user.id },
      create: { userId: user.id, tokenHash: hashToken(token), expiresAt },
      update: { tokenHash: hashToken(token), expiresAt, createdAt: new Date() },
    });
    await this.mail.sendVerifyEmail({
      to: user.email,
      name: user.name,
      link: new URL(
        `/verify-email/${token}`,
        this.config.get('WEB_ORIGIN', { infer: true }),
      ).toString(),
      expiresAt: expiresAt.toISOString(),
    });
    logEvent(this.logger, 'auth.verification_sent', { userId: user.id });
  }

  /**
   * Frees `email` for a new account when the account holding it was never confirmed and is older than a link lives,
   * so registering someone else's address blocks its owner for those 48 hours at most. The account is not deleted
   * (it may own workspaces and documents, which nothing here may destroy): it keeps its data under a placeholder
   * address, its sessions are revoked and its link is void. Returns the id of the account that was released.
   * Runs in the transaction that creates the new account, so a failed registration releases nothing; of two
   * registrations that arrive together, the second one finds the address taken.
   */
  async releaseStale(tx: Prisma.TransactionClient, email: string): Promise<string | null> {
    const now = new Date();
    const stale = await tx.user.findFirst({
      where: {
        email,
        emailVerifiedAt: null,
        createdAt: { lt: new Date(now.getTime() - EMAIL_VERIFICATION_TTL_MS) },
      },
      select: { id: true },
    });
    if (!stale) return null;
    const released = await tx.user.updateMany({
      where: { id: stale.id, email, emailVerifiedAt: null },
      data: { email: releasedAddress(stale.id) },
    });
    // another registration (or the owner's confirmation) got there first
    if (released.count === 0) return null;
    await tx.refreshToken.updateMany({
      where: { userId: stale.id, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.emailVerification.deleteMany({ where: { userId: stale.id } });
    return stale.id;
  }

  async resend(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppException('UNAUTHENTICATED', 'Authentication required');
    if (user.emailVerifiedAt) {
      throw new AppException('CONFLICT', 'Your email address is already confirmed');
    }
    await this.send(user);
  }

  async verify(token: string): Promise<void> {
    const pending = TOKEN_PATTERN.test(token)
      ? await this.prisma.emailVerification.findUnique({ where: { tokenHash: hashToken(token) } })
      : null;
    if (!pending || pending.expiresAt <= new Date()) {
      throw new AppException('BAD_REQUEST', 'This confirmation link is invalid or has expired');
    }
    await this.prisma.user.updateMany({
      where: { id: pending.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    logEvent(this.logger, 'auth.email_verified', { userId: pending.userId });
  }
}
