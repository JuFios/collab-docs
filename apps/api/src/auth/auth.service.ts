import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@collab-docs/db';
import { type AuthSession, type AuthUser, signAccessToken } from '@collab-docs/shared';
import { APP_CONFIG, AppException, type AppConfig, logEvent } from '@collab-docs/nest';
import type { LoginDto, RegisterDto } from './auth.dto';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';

/** What the controller needs to answer: the JSON body plus the cookies to set. */
export interface IssuedSession {
  session: AuthSession;
  /** Absent when the refresh token was not rotated (grace window): the browser keeps the one it got. */
  refreshToken?: string;
}

const toAuthUser = (user: { id: string; email: string; name: string }): AuthUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
});

const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RefreshTokenService) private readonly refreshTokens: RefreshTokenService,
  ) {}

  async register(dto: RegisterDto): Promise<IssuedSession> {
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      const user = await this.prisma.user.create({
        data: { email: dto.email, name: dto.name, passwordHash },
      });
      logEvent('auth.registered', { userId: user.id });
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
      logEvent('auth.login_failed');
      throw new AppException('UNAUTHENTICATED', INVALID_CREDENTIALS);
    }
    logEvent('auth.logged_in', { userId: user.id });
    return this.start(user);
  }

  async refresh(presented: string): Promise<IssuedSession> {
    const result = await this.refreshTokens.rotate(presented);
    const user = await this.prisma.user.findUnique({ where: { id: result.userId } });
    if (!user) throw new AppException('UNAUTHENTICATED', 'Invalid or expired session');
    const session = await this.session(user);
    return result.kind === 'rotated' ? { session, refreshToken: result.token } : { session };
  }

  async logout(presented: string | undefined): Promise<void> {
    if (!presented) return;
    await this.refreshTokens.revokeFamilyOf(presented);
    logEvent('auth.logged_out');
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppException('UNAUTHENTICATED', 'Authentication required');
    return toAuthUser(user);
  }

  private async start(user: { id: string; email: string; name: string }): Promise<IssuedSession> {
    return {
      session: await this.session(user),
      refreshToken: await this.refreshTokens.issue(user.id),
    };
  }

  private async session(user: { id: string; email: string; name: string }): Promise<AuthSession> {
    const { token, expiresIn } = await signAccessToken(this.config.JWT_ACCESS_SECRET, user.id);
    return { user: toAuthUser(user), accessToken: token, expiresIn };
  }
}
