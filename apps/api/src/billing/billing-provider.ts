/** Injection token of the payment provider in use (`BILLING_PROVIDER`). */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

/**
 * What the billing module asks of a payment provider. Everything the provider decides comes back as a signed
 * webhook event, never as a return value: the subscription changes in one place only.
 */
export interface BillingProvider {
  /** Path or URL of the page where the customer pays for the checkout session. */
  checkoutUrl(sessionId: string): string;
  /** Asks the provider to end the workspace's subscription; it answers with `customer.subscription.deleted`. */
  cancelSubscription(workspaceId: string): Promise<void>;
}
