'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form';
import { settleCheckoutAction } from '@/lib/billing/mock-checkout-actions';

type Outcome = 'pay' | 'fail' | 'pay_and_redeliver';

/**
 * The buttons of the payment page: one form whose submit buttons each carry an outcome, so it works without
 * JavaScript. The action sends it to the provider and redirects to billing.
 */
export function MockCheckoutForm({
  sessionId,
  amountLabel,
  showRedeliver,
}: {
  sessionId: string;
  amountLabel: string;
  showRedeliver: boolean;
}) {
  const [state, formAction, pending] = useActionState(settleCheckoutAction, {});
  const [chosen, setChosen] = useState<Outcome>();
  const busy = (outcome: Outcome) => pending && chosen === outcome;
  const submit = (outcome: Outcome) => ({
    type: 'submit' as const,
    name: 'outcome',
    value: outcome,
    disabled: pending,
    onClick: () => setChosen(outcome),
  });

  return (
    <form action={formAction} className="grid gap-3">
      <FormError message={state.formError} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <Button size="lg" {...submit('pay')}>
        {busy('pay') ? 'Processing…' : `Pay ${amountLabel}`}
      </Button>
      <Button variant="outline" size="lg" {...submit('fail')}>
        {busy('fail') ? 'Declining…' : 'Fail payment'}
      </Button>
      {showRedeliver ? (
        <div className="grid gap-1.5 border-t pt-3">
          <Button variant="ghost" size="sm" {...submit('pay_and_redeliver')}>
            {busy('pay_and_redeliver') ? 'Processing…' : 'Pay and re-send webhook'}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Development only: the provider sends the payment event twice, and the second delivery
            changes nothing.
          </p>
        </div>
      ) : null}
    </form>
  );
}
