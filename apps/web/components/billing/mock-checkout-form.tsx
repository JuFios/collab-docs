'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/ui/form';
import { settleCheckoutAction } from '@/lib/billing/mock-checkout-actions';
import { useActionRunner } from './use-action-runner';

type Outcome = 'pay' | 'fail' | 'pay_and_redeliver';

/** The buttons of the payment page. Each sends one outcome to the provider; the page then leaves for billing. */
export function MockCheckoutForm({
  sessionId,
  amountLabel,
  showRedeliver,
}: {
  sessionId: string;
  amountLabel: string;
  showRedeliver: boolean;
}) {
  const { state, pending, execute } = useActionRunner(settleCheckoutAction);
  const [chosen, setChosen] = useState<Outcome>();

  function settle(outcome: Outcome) {
    setChosen(outcome);
    execute({ sessionId, outcome });
  }
  const busy = (outcome: Outcome) => pending && chosen === outcome;

  return (
    <div className="grid gap-3">
      <FormError message={state.formError} />
      <Button size="lg" disabled={pending} onClick={() => settle('pay')}>
        {busy('pay') ? 'Processing…' : `Pay ${amountLabel}`}
      </Button>
      <Button variant="outline" size="lg" disabled={pending} onClick={() => settle('fail')}>
        {busy('fail') ? 'Declining…' : 'Fail payment'}
      </Button>
      {showRedeliver ? (
        <div className="grid gap-1.5 border-t pt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => settle('pay_and_redeliver')}
          >
            {busy('pay_and_redeliver') ? 'Processing…' : 'Pay and re-send webhook'}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Development only: the provider sends the payment event twice, and the second delivery
            changes nothing.
          </p>
        </div>
      ) : null}
    </div>
  );
}
