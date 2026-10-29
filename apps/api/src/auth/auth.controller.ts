import { Body, Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiFoundResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { type AuthSession, REFRESH_COOKIE, sanitizeNextPath } from '@collab-docs/shared';
import { AppException, type AppConfig, RateLimit } from '@collab-docs/nest';
import { CurrentUser, Public } from './auth.decorators';
import {
  AuthSessionResponse,
  AuthUserResponse,
  LoginDto,
  RegisterDto,
  VerifyEmailDto,
} from './auth.dto';
import { type IssuedSession, AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import type { RequestUser } from './auth.types';
import { clearAuthCookies, readCookie, setAccessCookie, setRefreshCookie } from './cookies';
import { clientFingerprint } from './refresh-token.service';

/** The client presenting a refresh token; `req.ip` is resolved through the trusted proxies only. */
const clientOf = (req: Request): string =>
  clientFingerprint({ userAgent: req.get('user-agent'), ip: req.ip });

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly verification: EmailVerificationService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private get cookieEnv(): Pick<AppConfig, 'APP_ENV'> {
    return { APP_ENV: this.config.get('APP_ENV', { infer: true }) };
  }

  @Public()
  @Post('register')
  @RateLimit.register()
  @ApiOperation({ summary: 'Create an account and sign in' })
  @ApiCreatedResponse({ type: AuthSessionResponse })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    return this.respond(res, await this.auth.register(dto));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit.login()
  @ApiOperation({ summary: 'Sign in with email and password' })
  @ApiOkResponse({ type: AuthSessionResponse })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    return this.respond(res, await this.auth.login(dto));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiCookieAuth('refresh-cookie')
  @ApiOperation({
    summary: 'Rotate the refresh token (cookie cd_rt) and issue a new access token',
    description:
      'Presenting a token rotated less than 10 s ago, from the same client (User-Agent and address), returns a ' +
      'new access token without a new rotation; any other reuse revokes the whole token family.',
  })
  @ApiOkResponse({ type: AuthSessionResponse })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    const presented = readCookie(req, REFRESH_COOKIE);
    if (!presented) throw new AppException('UNAUTHENTICATED', 'Invalid or expired session');
    try {
      return this.respond(res, await this.auth.refresh(presented, clientOf(req)));
    } catch (error) {
      if (error instanceof AppException && error.code === 'UNAUTHENTICATED') {
        clearAuthCookies(res, this.cookieEnv);
      }
      throw error;
    }
  }

  @Public()
  @Get('refresh')
  @ApiCookieAuth('refresh-cookie')
  @ApiQuery({
    name: 'next',
    required: false,
    description: 'Same-origin relative path to return to',
  })
  @ApiOperation({
    summary: 'Browser navigation refresh: rotate the session and redirect to `next`',
    description:
      'The refresh cookie is scoped to /api/auth, so the web edge middleware cannot read it on page ' +
      'requests. When the access token has expired it redirects the browser here; on success the ' +
      'cookies are renewed and the browser is sent to `next`, otherwise to /login?next=<next>.',
  })
  @ApiFoundResponse({ description: 'Redirect to `next` (or to /login on failure)' })
  async refreshAndRedirect(
    @Req() req: Request,
    @Res() res: Response,
    @Query('next') nextParam?: string,
  ): Promise<void> {
    const next = sanitizeNextPath(typeof nextParam === 'string' ? nextParam : undefined);
    // a redirect that rotates the session must never be replayed from a cache
    res.setHeader('Cache-Control', 'no-store');
    const presented = readCookie(req, REFRESH_COOKIE);
    try {
      if (!presented) throw new AppException('UNAUTHENTICATED', 'Invalid or expired session');
      this.respond(res, await this.auth.refresh(presented, clientOf(req)));
      res.redirect(302, next);
    } catch (error) {
      if (!(error instanceof AppException) || error.code !== 'UNAUTHENTICATED') throw error;
      clearAuthCookies(res, this.cookieEnv);
      res.redirect(302, `/login?next=${encodeURIComponent(next)}`);
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth('refresh-cookie')
  @ApiOperation({ summary: 'Revoke the refresh token family and clear the cookies' })
  @ApiNoContentResponse()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readCookie(req, REFRESH_COOKIE));
    clearAuthCookies(res, this.cookieEnv);
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Confirm the email address of an account with the token from the confirmation email',
  })
  @ApiNoContentResponse()
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<void> {
    await this.verification.verify(dto.token);
  }

  @Post('verify-email/resend')
  @HttpCode(204)
  @RateLimit.user('verifyEmail')
  @ApiBearerAuth()
  @ApiCookieAuth('access-cookie')
  @ApiOperation({ summary: 'Email a new confirmation link to the signed-in user' })
  @ApiNoContentResponse()
  async resendVerification(@CurrentUser() user: RequestUser): Promise<void> {
    await this.verification.resend(user.id);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiCookieAuth('access-cookie')
  @ApiOperation({ summary: 'The signed-in user' })
  @ApiOkResponse({ type: AuthUserResponse })
  me(@CurrentUser() user: RequestUser): Promise<AuthUserResponse> {
    return this.auth.me(user.id);
  }

  private respond(res: Response, issued: IssuedSession): AuthSession {
    setAccessCookie(res, this.cookieEnv, issued.session.accessToken);
    if (issued.refreshToken) setRefreshCookie(res, this.cookieEnv, issued.refreshToken);
    return issued.session;
  }
}
