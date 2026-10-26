import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, type RequestUser } from '../auth';
import type { WorkspaceRole as Role } from '@collab-docs/shared';
import { CurrentWorkspaceRole, WorkspaceRole } from '../permissions';
import type { Usage } from './plan-limits.service';
import {
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
  UsageResponse,
  WorkspaceResponse,
} from './workspaces.dto';
import { WorkspacesService } from './workspaces.service';

@ApiTags('workspaces')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller('workspaces')
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a workspace; the caller becomes its owner on the FREE plan' })
  @ApiCreatedResponse({ type: WorkspaceResponse })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateWorkspaceDto) {
    return this.workspaces.create(user.id, dto.name);
  }

  @Get()
  @ApiOperation({ summary: 'Workspaces the caller is a member of' })
  @ApiOkResponse({ type: [WorkspaceResponse] })
  list(@CurrentUser() user: RequestUser) {
    return this.workspaces.listForUser(user.id);
  }

  @Get(':workspaceId')
  @WorkspaceRole('VIEWER')
  @ApiOperation({ summary: 'A workspace the caller belongs to (404 otherwise)' })
  @ApiOkResponse({ type: WorkspaceResponse })
  get(@Param('workspaceId') workspaceId: string, @CurrentWorkspaceRole() role: Role) {
    return this.workspaces.get(workspaceId, role);
  }

  @Patch(':workspaceId')
  @WorkspaceRole('ADMIN')
  @ApiOperation({ summary: 'Rename the workspace (admin or owner)' })
  @ApiOkResponse({ type: WorkspaceResponse })
  rename(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
    @CurrentWorkspaceRole() role: Role,
  ) {
    return this.workspaces.rename(workspaceId, role, dto.name);
  }

  @Get(':workspaceId/usage')
  @WorkspaceRole('VIEWER')
  @ApiOperation({ summary: 'Members, documents and storage against the plan limits' })
  @ApiOkResponse({ type: UsageResponse })
  usage(@Param('workspaceId') workspaceId: string): Promise<Usage> {
    return this.workspaces.usage(workspaceId);
  }
}
