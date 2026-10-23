import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { type AuthSession, REFRESH_COOKIE } from '@collab-docs/shared';
import { APP_CONFIG, AppException, type AppConfig, RateLimit } from '@collab-docs/shared/nest';
import { CurrentUser, Public } from './auth.decorators';
import { AuthSessionResponse, AuthUserResponse, LoginDto, RegisterDto } from './auth.dto';
import { type IssuedSession, AuthService } from './auth.service';
import type { RequestUser } from './auth.types';
import { clearAuthCookies, readCookie, setAccessCookie, setRefreshCookie } from './cookies';
import { LoginThrottleGuard } from './login-throttle.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

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
  @UseGuards(LoginThrottleGuard)
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
      'Presenting a token rotated less than 30 s ago returns a new access token without a new rotation; ' +
      'later reuse revokes the whole token family.',
  })
  @ApiOkResponse({ type: AuthSessionResponse })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    const presented = readCookie(req, REFRESH_COOKIE);
    if (!presented) throw new AppException('UNAUTHENTICATED', 'Invalid or expired session');
    try {
      return this.respond(res, await this.auth.refresh(presented));
    } catch (error) {
      if (error instanceof AppException && error.code === 'UNAUTHENTICATED') {
        clearAuthCookies(res, this.config);
      }
      throw error;
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
    clearAuthCookies(res, this.config);
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
    setAccessCookie(res, this.config, issued.session.accessToken);
    if (issued.refreshToken) setRefreshCookie(res, this.config, issued.refreshToken);
    return issued.session;
  }
}
