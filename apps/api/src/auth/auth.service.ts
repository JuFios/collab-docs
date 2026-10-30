import { Injectable } from '@nestjs/common';
import { Prisma, type User } from '@collab-docs/db';
import {
  type AuthSession,
  type AuthUser,
  isReleasedEmail,
  releasedEmail,
} from '@collab-docs/shared';
import { AppException, logEvent, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';
import { AccessTokenService } from './access-token.service';
import type { LoginDto, RegisterDto } from './auth.dto';
import { EMAIL_VERIFICATION_TTL_MS, EmailVerificationService } from './email-verification.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { PrismaService } from '../prisma/prisma.service';

/** What the controller needs to answer: the JSON body plus the cookies to set. */
export interface IssuedSession {
  session: AuthSession;
  /** Absent when the refresh token was not rotated (grace window): the browser keeps the one it got. */
  refreshToken?: string;
}

type UserRow = { id: string; email: string; name: string; emailVerifiedAt: Date | null };

const toAuthUser = (user: UserRow): AuthUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  emailVerified: user.emailVerifiedAt !== null,
});

const INVALID_CREDENTIALS = 'Invalid email or password';

const emailTaken = () => new AppException('CONFLICT', 'An account with this email already exists');
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessTokens: AccessTokenService,
    private readonly passwords: PasswordService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly verification: EmailVerificationService,
    @InjectPinoLogger(AuthService.name) private readonly logger: PinoLogger,
  ) {}

  async register(dto: RegisterDto): Promise<IssuedSession> {
    const passwordHash = await this.passwords.hash(dto.password);
    const user = await this.createAccount(dto, passwordHash);
    logEvent(this.logger, 'auth.registered', { userId: user.id });
    // the account works without it; a link that could not be queued is asked for again from the app
    await this.verification.send(user).catch((error: unknown) => {
      this.logger.warn({ err: error, userId: user.id }, 'confirmation email not queued');
    });
    return this.start(user);
  }

  /**
   * Creates the account. An address that is taken is given up only by an account that never confirmed it and is older
   * than a confirmation link lives, so that registering somebody else's address blocks its owner for those 48 hours
   * at most; anything else is a conflict. Taking an address over is a transaction of its own, so the common cases
   * (a free address, a confirmed or recent holder) cost no more than the insert.
   */
  private async createAccount(dto: RegisterDto, passwordHash: string): Promise<User> {
    const data = { email: dto.email, name: dto.name, passwordHash };
    try {
      return await this.prisma.user.create({ data });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    let released: string | null = null;
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        released = await this.releaseStale(tx, dto.email);
        if (!released) throw emailTaken();
        return tx.user.create({ data });
      });
      logEvent(this.logger, 'auth.address_released', { userId: released, replacedBy: user.id });
      return user;
    } catch (error) {
      // of two registrations that arrive together, the second finds the address taken
      throw isUniqueViolation(error) ? emailTaken() : error;
    }
  }

  /**
   * Frees `email` from an account that never confirmed it and is older than a link lives (counted from the account,
   * so asking for a new link does not extend it). The account is not deleted: it may own workspaces and documents,
   * which nothing here may destroy. It keeps them under a placeholder address nobody can register or sign in with,
   * its sessions are revoked and its link is void. Every update is conditional on the account still holding the
   * address unconfirmed, so a confirmation that wins the race keeps the address. Returns the id of the account.
   */
  private async releaseStale(tx: Prisma.TransactionClient, email: string): Promise<string | null> {
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
      data: { email: releasedEmail(stale.id) },
    });
    if (released.count === 0) return null;
    await this.refreshTokens.revokeAllOf(stale.id, tx, now);
    await this.verification.discard(stale.id, tx);
    return stale.id;
  }

  async login(dto: LoginDto): Promise<IssuedSession> {
    // the placeholder of a released account is never a login, whatever password comes with it
    const user = isReleasedEmail(dto.email)
      ? null
      : await this.prisma.user.findUnique({ where: { email: dto.email } });
    // one message and one code path for "no such user" and "wrong password": no user enumeration
    const valid = user
      ? await this.passwords.verify(user.passwordHash, dto.password)
      : await this.passwords.verifyAgainstDummy(dto.password);
    if (!user || !valid) {
      logEvent(this.logger, 'auth.login_failed');
      throw new AppException('UNAUTHENTICATED', INVALID_CREDENTIALS);
    }
    logEvent(this.logger, 'auth.logged_in', { userId: user.id });
    return this.start(user);
  }

  /** `client` is `clientFingerprint()` of the request (see the grace window of `RefreshTokenService`). */
  async refresh(presented: string, client: string): Promise<IssuedSession> {
    const result = await this.refreshTokens.rotate(presented, client);
    const user = await this.prisma.user.findUnique({ where: { id: result.userId } });
    if (!user) throw new AppException('UNAUTHENTICATED', 'Invalid or expired session');
    if (isReleasedEmail(user.email)) {
      // a token issued while the account was being released escaped its revocation: it ends here
      await this.refreshTokens.revokeAllOf(user.id);
      throw new AppException('UNAUTHENTICATED', 'Invalid or expired session');
    }
    const session = await this.session(user);
    return result.kind === 'rotated' ? { session, refreshToken: result.token } : { session };
  }

  async logout(presented: string | undefined): Promise<void> {
    if (!presented) return;
    await this.refreshTokens.revokeFamilyOf(presented);
    logEvent(this.logger, 'auth.logged_out');
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // an access token outlives the release of its account by up to 15 minutes, but nobody is signed in as it
    if (!user || isReleasedEmail(user.email)) {
      throw new AppException('UNAUTHENTICATED', 'Authentication required');
    }
    return toAuthUser(user);
  }

  private async start(user: UserRow): Promise<IssuedSession> {
    return {
      session: await this.session(user),
      refreshToken: await this.refreshTokens.issue(user.id),
    };
  }

  private async session(user: UserRow): Promise<AuthSession> {
    const { token, expiresIn } = await this.accessTokens.sign(user.id);
    return { user: toAuthUser(user), accessToken: token, expiresIn };
  }
}
