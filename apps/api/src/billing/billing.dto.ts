import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  CHECKOUT_PLANS,
  PLAN_TIERS,
  SUBSCRIPTION_STATUSES,
  type CheckoutPlan,
  type CheckoutStarted,
  type InvoiceInfo,
  type LimitKind,
  type PlanInfo,
  type PlanTier,
  type SubscriptionStatus,
  type UsageFigure,
} from '@collab-docs/shared';

export class CreateCheckoutDto {
  @ApiProperty({ enum: CHECKOUT_PLANS })
  @IsIn(CHECKOUT_PLANS)
  plan!: CheckoutPlan;
}

export class PlanInfoResponse implements PlanInfo {
  @ApiProperty({ enum: PLAN_TIERS }) plan!: PlanTier;
  @ApiProperty({ description: 'Per month, in US cents' }) priceCents!: number;
  @ApiProperty() maxMembers!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'null = unlimited' })
  maxDocuments!: number | null;
  @ApiProperty() maxStorageBytes!: number;
}

export class CheckoutStartedResponse implements CheckoutStarted {
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty({
    example: '/mock-checkout/0f0e…',
    description: 'Path of the page where the payment is made',
  })
  checkoutUrl!: string;
}

export class InvoiceResponse implements InvoiceInfo {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: PLAN_TIERS }) plan!: PlanTier;
  @ApiProperty({ description: 'US cents' }) amountCents!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class UsageFigureResponse implements UsageFigure {
  @ApiProperty({ enum: ['members', 'documents', 'storage'] }) kind!: LimitKind;
  @ApiProperty({ description: 'Bytes for storage' }) current!: number;
  @ApiProperty({ nullable: true, type: Number, description: 'null = unlimited' })
  limit!: number | null;
}

export class BillingOverviewResponse {
  @ApiProperty({ enum: PLAN_TIERS }) plan!: PlanTier;
  @ApiProperty({ enum: SUBSCRIPTION_STATUSES }) status!: SubscriptionStatus;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  currentPeriodEnd!: string | null;
  @ApiProperty({
    type: [UsageFigureResponse],
    description: 'Members (with pending invites), documents, storage',
  })
  usage!: UsageFigureResponse[];
  @ApiProperty({
    type: [UsageFigureResponse],
    description:
      'Figures above the limits of the plan (after a downgrade). Existing content stays; creating more is refused with PLAN_LIMIT_EXCEEDED until the figure is back under the limit.',
  })
  overLimit!: UsageFigureResponse[];
  @ApiProperty({ type: [InvoiceResponse], description: 'Newest first' })
  invoices!: InvoiceResponse[];
}

export class CancelRequestedResponse {
  @ApiProperty({
    example: true,
    description: 'The provider was asked; the plan changes when its webhook event is applied',
  })
  requested!: boolean;
}

export class WebhookAckResponse {
  @ApiPropertyOptional({ example: true }) received?: boolean;
  @ApiPropertyOptional({ example: true, description: 'The event was processed earlier' })
  duplicate?: boolean;
}
