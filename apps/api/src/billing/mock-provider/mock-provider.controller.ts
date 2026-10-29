import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ParseUuidPipe, RateLimit } from '@collab-docs/nest';
import { Public } from '../../auth/auth.decorators';
import { EventIdPipe } from './event-id.pipe';
import { EventIssuedResponse, MockCheckoutSessionResponse } from './mock-provider.dto';
import { MockProviderService } from './mock-provider.service';

/**
 * What the hosted checkout page of a real provider does. Public like that page: the checkout session id is an
 * unguessable random UUID and is all it takes to pay for the session, which is how a real checkout link works. The
 * actions are rate limited per client address, since every one of them queues a delivery.
 */
@ApiTags('mock-provider')
@Public()
@Controller('mock-provider')
export class MockProviderController {
  constructor(private readonly provider: MockProviderService) {}

  @Get('checkout-sessions/:id')
  @ApiOperation({ summary: 'The checkout session shown on the payment page' })
  @ApiOkResponse({ type: MockCheckoutSessionResponse })
  session(@Param('id', ParseUuidPipe) id: string) {
    return this.provider.checkoutSession(id);
  }

  @Post('checkout-sessions/:id/complete')
  @HttpCode(202)
  @RateLimit.mockProvider()
  @ApiOperation({
    summary: 'Pays the session',
    description:
      'Issues `checkout.session.completed` and delivers it to the webhook through the queue. The plan changes ' +
      'when the webhook has applied the event, not before.',
  })
  @ApiAcceptedResponse({ type: EventIssuedResponse })
  @ApiConflictResponse({ description: 'The session was already settled' })
  async complete(@Param('id', ParseUuidPipe) id: string) {
    return { eventId: await this.provider.complete(id) };
  }

  @Post('checkout-sessions/:id/fail')
  @HttpCode(202)
  @RateLimit.mockProvider()
  @ApiOperation({ summary: 'Declines the payment (`checkout.session.failed`)' })
  @ApiAcceptedResponse({ type: EventIssuedResponse })
  @ApiConflictResponse({ description: 'The session was already settled' })
  async fail(@Param('id', ParseUuidPipe) id: string) {
    return { eventId: await this.provider.fail(id) };
  }

  @Post('events/:id/redeliver')
  @HttpCode(202)
  @RateLimit.mockProvider()
  @ApiOperation({
    summary: 'Delivers an event to the webhook again',
    description:
      'The receiver treats the repeat as a duplicate: the plan and the invoices stay as they are.',
  })
  @ApiAcceptedResponse({ type: EventIssuedResponse })
  async redeliver(@Param('id', EventIdPipe) id: string) {
    await this.provider.redeliver(id);
    return { eventId: id };
  }
}
