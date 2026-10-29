import { ApiProperty } from '@nestjs/swagger';
import { PLAN_TIERS, type PlanTier } from '@collab-docs/shared';

export class MockCheckoutSessionResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty({ enum: PLAN_TIERS }) plan!: PlanTier;
  @ApiProperty({ description: 'US cents' }) amountCents!: number;
  @ApiProperty({ enum: ['PENDING', 'COMPLETED', 'FAILED', 'CANCELED'] }) status!: string;
}

export class EventIssuedResponse {
  @ApiProperty({ example: 'evt_0f0e0d0c0b0a09080706050403020100' }) eventId!: string;
}
