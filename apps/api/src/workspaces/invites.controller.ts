import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ParseUuidPipe } from '@collab-docs/nest';
import { CurrentUser, Public } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { WorkspaceRole } from '../permissions/permissions.decorators';
import { InvitesService } from './invites.service';
import {
  AcceptInviteResponse,
  CreateInviteDto,
  InvitePreviewResponse,
  InviteResponse,
} from './workspaces.dto';

@ApiTags('invites')
@Controller()
export class InvitesController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  @Post('workspaces/:workspaceId/invites')
  @WorkspaceRole('ADMIN')
  @ApiBearerAuth()
  @ApiCookieAuth('access-cookie')
  @ApiOperation({
    summary: 'Invite an email to the workspace (emailed, valid 7 days)',
    description:
      'Re-inviting a pending email issues a new token. Counts against the plan member limit ' +
      '(403 PLAN_LIMIT_EXCEEDED); an existing member gives 409.',
  })
  @ApiCreatedResponse({ type: InviteResponse })
  create(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateInviteDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.invites.create(workspaceId, user.id, dto);
  }

  @Get('workspaces/:workspaceId/invites')
  @WorkspaceRole('ADMIN')
  @ApiBearerAuth()
  @ApiCookieAuth('access-cookie')
  @ApiOperation({ summary: 'Pending invites of the workspace' })
  @ApiOkResponse({ type: [InviteResponse] })
  list(@Param('workspaceId') workspaceId: string) {
    return this.invites.list(workspaceId);
  }

  @Delete('workspaces/:workspaceId/invites/:inviteId')
  @HttpCode(204)
  @WorkspaceRole('ADMIN')
  @ApiBearerAuth()
  @ApiCookieAuth('access-cookie')
  @ApiOperation({ summary: 'Revoke a pending invite' })
  @ApiNoContentResponse()
  revoke(
    @Param('workspaceId') workspaceId: string,
    @Param('inviteId', ParseUuidPipe) inviteId: string,
  ): Promise<void> {
    return this.invites.revoke(workspaceId, inviteId);
  }

  @Public()
  @Get('invites/:token')
  @ApiOperation({ summary: 'What an invite token is for (400 INVITE_INVALID if unusable)' })
  @ApiOkResponse({ type: InvitePreviewResponse })
  preview(@Param('token') token: string) {
    return this.invites.preview(token);
  }

  @Post('invites/:token/accept')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiCookieAuth('access-cookie')
  @ApiOperation({
    summary: 'Accept an invite as the signed-in user',
    description: 'The account email must equal the invited email (403 otherwise).',
  })
  @ApiOkResponse({ type: AcceptInviteResponse })
  accept(@Param('token') token: string, @CurrentUser() user: RequestUser) {
    return this.invites.accept(token, user.id);
  }
}
