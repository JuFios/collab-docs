import { Module } from '@nestjs/common';
import { PermissionsModule } from '../permissions/permissions.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { BillingEventsProcessor } from './billing-events.processor';
import { BillingEventsService } from './billing-events.service';
import { PlansController, WorkspaceBillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { MockProviderModule, MockProviderWorkerModule } from './mock-provider/mock-provider.module';
import { SubscriptionService } from './subscription.service';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

@Module({
  imports: [PrismaModule, PermissionsModule, WorkspacesModule, MockProviderModule],
  controllers: [PlansController, WorkspaceBillingController, WebhookController],
  providers: [BillingService, WebhookService],
})
export class BillingModule {}

/** Applies webhook events (`BillingEventsService`); imported by the worker process only, with the provider's delivery. */
@Module({
  imports: [PrismaModule, WorkspacesModule, MockProviderWorkerModule],
  providers: [BillingEventsProcessor, BillingEventsService, SubscriptionService],
})
export class BillingWorkerModule {}
