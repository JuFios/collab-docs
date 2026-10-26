import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { type AppConfig, RateLimit, signCollabTicket } from '@collab-docs/nest';
import { CurrentUser } from '../auth/auth.decorators';
import { type RequestUser } from '../auth/auth.types';
import { CurrentDocumentAccess, DocumentAccess } from '../permissions/permissions.decorators';
import { type DocumentAccessResult } from '../permissions/permissions.service';
import { CollabTicketResponse } from './collab-ticket.dto';

@ApiTags('collab')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller()
export class CollabTicketController {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  @Post('documents/:id/collab-ticket')
  @HttpCode(200)
  @DocumentAccess('VIEW', { param: 'id' })
  @RateLimit.user('ticket')
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
    const ticket = await signCollabTicket(
      this.config.get('COLLAB_TICKET_SECRET', { infer: true }),
      {
        docId: document.id,
        sub: user.id,
        correlationId: req.correlationId,
      },
    );
    return {
      ticket,
      wsUrl: `${this.config.get('COLLAB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '')}/ws`,
    };
  }
}
