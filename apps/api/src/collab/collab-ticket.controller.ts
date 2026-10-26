import { Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig, signCollabTicket } from '@collab-docs/shared/nest';
import { CurrentUser, type RequestUser } from '../auth';
import { CurrentDocumentAccess, DocumentAccess, type DocumentAccessResult } from '../permissions';
import { CollabTicketResponse } from './collab-ticket.dto';
import { TicketThrottleGuard } from './ticket-throttle.guard';

@ApiTags('collab')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller()
export class CollabTicketController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Post('documents/:id/collab-ticket')
  @HttpCode(200)
  @DocumentAccess('VIEW', { param: 'id' })
  @UseGuards(TicketThrottleGuard)
  @ApiOperation({
    summary: 'Ticket for the collaboration WebSocket of a document',
    description:
      'Requires at least VIEW. The ticket only identifies the caller: the collab service reads the ' +
      'permissions from the database when the socket opens and again whenever they change, so a viewer ' +
      'gets a read-only connection from the same ticket.',
  })
  @ApiOkResponse({ type: CollabTicketResponse })
  @ApiTooManyRequestsResponse({ description: 'RATE_LIMITED' })
  async issue(
    @CurrentUser() user: RequestUser,
    @CurrentDocumentAccess() { document }: DocumentAccessResult,
    @Req() req: Request,
  ): Promise<CollabTicketResponse> {
    const ticket = await signCollabTicket(this.config.COLLAB_TICKET_SECRET, {
      docId: document.id,
      sub: user.id,
      correlationId: req.correlationId,
    });
    return { ticket, wsUrl: `${this.config.COLLAB_PUBLIC_URL.replace(/\/+$/, '')}/ws` };
  }
}
