import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@collab-docs/db';
import { EMAIL_CONFIRMATION_HOURS, isReleasedEmail } from '@collab-docs/shared';
import {
  AppException,
  type AppConfig,
  logEvent,
  InjectPinoLogger,
  PinoLogger,
} from '@collab-docs/nest';
import { MailQueueService } from '../mail/mail-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from './refresh-token.service';

export const EMAIL_VERIFICATION_TTL_MS = EMAIL_CONFIRMATION_HOURS * 3600 * 1000;
/** Well-formed tokens are 43 base64url characters (256 bits); anything else cannot match and skips the lookup. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const invalidLink = () =>
  new AppException('BAD_REQUEST', 'This confirmation link is invalid or has expired');

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

  /** Voids the pending link of the user, in `db` when the caller is inside a transaction. */
  async discard(
    userId: string,
    db: Pick<Prisma.TransactionClient, 'emailVerification'> = this.prisma,
  ): Promise<void> {
    await db.emailVerification.deleteMany({ where: { userId } });
  }

  async resend(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // an account that gave up its address has none to confirm (its old session may still hold an access token)
    if (!user || isReleasedEmail(user.email)) {
      throw new AppException('UNAUTHENTICATED', 'Authentication required');
    }
    if (user.emailVerifiedAt) {
      throw new AppException('CONFLICT', 'Your email address is already confirmed');
    }
    await this.send(user);
  }

  async verify(token: string): Promise<void> {
    const pending = TOKEN_PATTERN.test(token)
      ? await this.prisma.emailVerification.findUnique({
          where: { tokenHash: hashToken(token) },
          include: { user: { select: { email: true } } },
        })
      : null;
    if (!pending || pending.expiresAt <= new Date()) throw invalidLink();
    // bound to the address the link went to: an account released to a new registration meanwhile is not confirmed
    const confirmed = await this.prisma.user.updateMany({
      where: { id: pending.userId, email: pending.user.email, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    if (confirmed.count === 0) {
      // opening the link again is fine; losing the address to somebody else in the meantime is not
      const user = await this.prisma.user.findUnique({
        where: { id: pending.userId },
        select: { emailVerifiedAt: true },
      });
      if (!user?.emailVerifiedAt) throw invalidLink();
      return;
    }
    logEvent(this.logger, 'auth.email_verified', { userId: pending.userId });
  }
}
