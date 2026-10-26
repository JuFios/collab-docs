import { Controller, type MessageEvent, Query, Sse } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Observable } from 'rxjs';
import { ParseUuidPipe } from '@collab-docs/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { PermissionsService } from '../permissions/permissions.service';
import { eventStream } from './event-stream';
import { RealtimeEventsService } from './realtime-events.service';

@ApiTags('events')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@SkipThrottle()
@Controller('events')
export class EventsController {
  constructor(
    private readonly realtime: RealtimeEventsService,
    private readonly permissions: PermissionsService,
  ) {}

  @ApiOperation({
    summary: 'Server-sent events for a workspace and the caller',
    description:
      "`tree.changed` for the workspace plus the caller's personal events. One connection per browser tab. " +
      'Members only (404 otherwise); the stream closes when membership is lost.',
  })
  @ApiQuery({ name: 'workspaceId', format: 'uuid' })
  @Sse('stream')
  async stream(
    @Query('workspaceId', ParseUuidPipe) workspaceId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Observable<MessageEvent>> {
    await this.permissions.assertWorkspaceRole(user.id, workspaceId, 'VIEWER');
    return eventStream({
      envelopes: await this.realtime.stream(workspaceId, user.id),
      isMember: async () =>
        (await this.permissions.getWorkspaceRole(user.id, workspaceId)) !== null,
    });
  }
}
