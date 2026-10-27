import { Injectable } from '@nestjs/common';
import type { BillingProvider } from '../billing-provider';
import { MockProviderService } from './mock-provider.service';

/** The mock provider as the billing module sees it. */
@Injectable()
export class MockBillingProvider implements BillingProvider {
  constructor(private readonly provider: MockProviderService) {}

  checkoutUrl(sessionId: string): string {
    return `/mock-checkout/${sessionId}`;
  }

  cancelSubscription(workspaceId: string): Promise<void> {
    return this.provider.cancelSubscription(workspaceId);
  }
}
