import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { ParseUuidPipe } from '@collab-docs/shared/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { PermissionsService } from '../permissions/permissions.service';
import { RealtimeEventsService } from './realtime-events.service';

const HEARTBEAT_MS = 25_000;

@ApiTags('events')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@SkipThrottle()
@Controller('events')
export class EventsController {
  constructor(
    @Inject(RealtimeEventsService) private readonly realtime: RealtimeEventsService,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
  ) {}

  @Get('stream')
  @ApiOperation({
    summary: 'Server-sent events for a workspace and the caller',
    description:
      "`tree.changed` for the workspace plus the caller's personal events. One connection per browser tab. " +
      'Members only (404 otherwise); the stream closes when membership is lost.',
  })
  @ApiQuery({ name: 'workspaceId', format: 'uuid' })
  async stream(
    @Query('workspaceId', ParseUuidPipe) workspaceId: string,
    @CurrentUser() user: RequestUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.permissions.assertWorkspaceRole(user.id, workspaceId, 'VIEWER');
    const events = await this.realtime.stream(workspaceId, user.id);

    // no-transform and X-Accel-Buffering keep proxies (including the Next.js rewrite) from buffering the stream
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    const subscription = events.subscribe((envelope) => {
      res.write(`event: ${envelope.event.type}\ndata: ${JSON.stringify(envelope.event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
      // a removed member must not keep receiving the workspace's events
      void this.permissions.getWorkspaceRole(user.id, workspaceId).then((role) => {
        if (!role) res.end();
      });
    }, HEARTBEAT_MS);
    const close = () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);
  }
}
