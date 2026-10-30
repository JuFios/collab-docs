import { Injectable } from '@nestjs/common';
import { Prisma } from '@collab-docs/db';
import type { AuthSession, AuthUser } from '@collab-docs/shared';
import { AppException, logEvent, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';
import { AccessTokenService } from './access-token.service';
import type { LoginDto, RegisterDto } from './auth.dto';
import { EmailVerificationService } from './email-verification.service';
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
    try {
      const { user, released } = await this.prisma.$transaction(async (tx) => {
        // an address held by an account that never confirmed it, for longer than a link lives, is taken over
        const released = await this.verification.releaseStale(tx, dto.email);
        const user = await tx.user.create({
          data: { email: dto.email, name: dto.name, passwordHash },
        });
        return { user, released };
      });
      if (released) {
        logEvent(this.logger, 'auth.address_released', { userId: released, replacedBy: user.id });
      }
      logEvent(this.logger, 'auth.registered', { userId: user.id });
      // the account works without it; a link that could not be queued is asked for again from the app
      await this.verification.send(user).catch((error: unknown) => {
        this.logger.warn({ err: error, userId: user.id }, 'confirmation email not queued');
      });
      return this.start(user);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException('CONFLICT', 'An account with this email already exists');
      }
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
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
    if (!user) throw new AppException('UNAUTHENTICATED', 'Authentication required');
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
