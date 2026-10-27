import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ParseUuidPipe, RateLimit } from '@collab-docs/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { WorkspaceRole } from '../permissions/permissions.decorators';
import { SearchPageResponse, SearchQueryDto } from './search.dto';
import { SearchService } from './search.service';

@ApiTags('search')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller()
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('workspaces/:workspaceId/search')
  @WorkspaceRole('VIEWER')
  // below the access decorator on purpose: guards run bottom-up, and a probe of somebody else's id must count
  @RateLimit.user('search')
  @ApiOperation({
    summary: 'Full-text search in a workspace',
    description:
      'Members only (guests with a share get 404). Returns the documents the caller can open, best match first: ' +
      'title weighs more than body, words are matched as prefixes and ignore case and accents. The index is ' +
      'updated a few seconds after an edit; permissions are checked at request time. Rate limited per user (60 per minute by default).',
  })
  @ApiOkResponse({ type: SearchPageResponse })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  find(
    @Param('workspaceId', ParseUuidPipe) workspaceId: string,
    @Query() query: SearchQueryDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.search.search(user.id, workspaceId, query);
  }
}
