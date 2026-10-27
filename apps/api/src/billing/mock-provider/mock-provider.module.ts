import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BILLING_PROVIDER } from '../billing-provider';
import { MockBillingProvider } from './mock-billing-provider';
import { MockDeliveryProcessor } from './mock-delivery.processor';
import { MockProviderController } from './mock-provider.controller';
import { MockProviderService } from './mock-provider.service';

/**
 * The mock payment provider (`BILLING_PROVIDER=mock`, the default in dev and staging). It is a module of its own
 * and talks to the rest of the app only through `BILLING_PROVIDER` and the signed webhook, as a real provider
 * (Stripe) would sit in its place.
 */
@Module({
  imports: [PrismaModule],
  controllers: [MockProviderController],
  providers: [
    MockProviderService,
    MockBillingProvider,
    { provide: BILLING_PROVIDER, useExisting: MockBillingProvider },
  ],
  exports: [BILLING_PROVIDER],
})
export class MockProviderModule {}

/** Registers the delivery processor of the mock provider; imported by the worker process only. */
@Module({
  imports: [HttpModule, PrismaModule],
  providers: [MockDeliveryProcessor],
})
export class MockProviderWorkerModule {}
