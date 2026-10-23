import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ParseUuidPipe } from '@collab-docs/shared/nest';
import { CurrentUser, type RequestUser } from '../auth';
import { WorkspaceRole } from '../permissions';
import { MembersService } from './members.service';
import { MemberResponse, UpdateMemberDto } from './workspaces.dto';

@ApiTags('members')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller('workspaces/:workspaceId/members')
export class MembersController {
  constructor(@Inject(MembersService) private readonly members: MembersService) {}

  @Get()
  @WorkspaceRole('VIEWER')
  @ApiOperation({ summary: 'Members of the workspace' })
  @ApiOkResponse({ type: [MemberResponse] })
  list(@Param('workspaceId') workspaceId: string) {
    return this.members.list(workspaceId);
  }

  @Patch(':userId')
  @WorkspaceRole('ADMIN')
  @ApiOperation({
    summary: 'Change a member role',
    description:
      'Admins cannot change owners or grant OWNER; the last owner cannot be demoted (409).',
  })
  @ApiOkResponse({ type: MemberResponse })
  changeRole(
    @Param('workspaceId') workspaceId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.members.changeRole(workspaceId, { id: user.id }, userId, dto.role);
  }

  @Delete(':userId')
  @HttpCode(204)
  @WorkspaceRole('VIEWER')
  @ApiOperation({
    summary: 'Remove a member, or leave the workspace when userId is the caller',
    description: 'Removing others needs admin or owner; the last owner cannot leave (409).',
  })
  @ApiNoContentResponse()
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<void> {
    return this.members.remove(workspaceId, { id: user.id }, userId);
  }
}
