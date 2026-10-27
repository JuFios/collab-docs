import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { WorkspaceRole } from '../permissions/permissions.decorators';
import {
  BillingOverviewResponse,
  CancelRequestedResponse,
  CheckoutStartedResponse,
  CreateCheckoutDto,
  PlanInfoResponse,
} from './billing.dto';
import { BillingService } from './billing.service';

@ApiTags('billing')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller('billing')
export class PlansController {
  constructor(private readonly billing: BillingService) {}

  @Get('plans')
  @ApiOperation({ summary: 'The plans, their prices and limits' })
  @ApiOkResponse({ type: [PlanInfoResponse] })
  plans() {
    return this.billing.plans();
  }
}

@ApiTags('billing')
@ApiBearerAuth()
@ApiCookieAuth('access-cookie')
@Controller('workspaces/:workspaceId/billing')
export class WorkspaceBillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @WorkspaceRole('ADMIN')
  @ApiOperation({
    summary: 'Plan, subscription status, usage against the limits, over-limit figures, invoices',
    description: 'Owner or admin.',
  })
  @ApiOkResponse({ type: BillingOverviewResponse })
  overview(@Param('workspaceId') workspaceId: string) {
    return this.billing.overview(workspaceId);
  }

  @Post('checkout')
  @WorkspaceRole('ADMIN')
  @ApiOperation({
    summary: 'Starts a checkout for a paid plan',
    description:
      'Owner or admin. Returns the page where the payment is made; the plan changes only when the provider ' +
      'confirms the payment with a webhook event.',
  })
  @ApiCreatedResponse({ type: CheckoutStartedResponse })
  @ApiConflictResponse({ description: 'The workspace is already on that plan' })
  checkout(@Param('workspaceId') workspaceId: string, @Body() dto: CreateCheckoutDto) {
    return this.billing.checkout(workspaceId, dto.plan);
  }

  @Post('cancel')
  @HttpCode(202)
  @WorkspaceRole('ADMIN')
  @ApiOperation({
    summary: 'Cancels the paid plan',
    description:
      'Owner or admin. Asks the provider to end the subscription; the workspace returns to FREE when the ' +
      'provider’s webhook event is applied. What exceeds the FREE limits stays, but nothing new can be added.',
  })
  @ApiAcceptedResponse({ type: CancelRequestedResponse })
  @ApiConflictResponse({ description: 'The workspace is on the FREE plan' })
  async cancel(@Param('workspaceId') workspaceId: string) {
    await this.billing.cancel(workspaceId);
    return { requested: true };
  }
}
