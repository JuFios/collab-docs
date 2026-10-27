import { Controller, Headers, HttpCode, Post, type RawBodyRequest, Req } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { MOCK_SIGNATURE_HEADER } from '@collab-docs/shared';
import { Public } from '../auth/auth.decorators';
import { WebhookAckResponse } from './billing.dto';
import { WebhookService } from './webhook.service';

@ApiTags('billing')
@Controller('billing/webhooks')
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  /**
   * Public and cookie-less by design: the provider authenticates with the signature, and a request without
   * auth cookies is outside the CSRF guard's scope.
   */
  @Public()
  @Post('mock')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receives an event of the mock payment provider',
    description:
      'The body is signed: `Mock-Signature: t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<raw body>">` with ' +
      '`WEBHOOK_SIGNING_SECRET`, and `t` may differ from the clock by 5 minutes at most. Delivery is ' +
      'at-least-once: an event that was already processed is acknowledged with `{ duplicate: true }` and ' +
      'changes nothing.',
  })
  @ApiHeader({ name: MOCK_SIGNATURE_HEADER, required: true })
  @ApiOkResponse({ type: WebhookAckResponse })
  @ApiUnauthorizedResponse({ description: 'WEBHOOK_SIGNATURE_INVALID' })
  receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers(MOCK_SIGNATURE_HEADER.toLowerCase()) signature: string | undefined,
  ) {
    return this.webhooks.receive(request.rawBody, signature);
  }
}
