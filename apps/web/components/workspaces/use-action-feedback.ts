'use client';

import { useRouter } from 'next/navigation';
import { startTransition, useEffect } from 'react';
import { toast } from 'sonner';
import { emitPlanLimitExceeded } from '@/lib/api/plan-limit-events';
import type { ActionState } from '@/lib/workspaces/action-state';

/**
 * Side effects of a finished action: a success toast, navigation or a refresh of the Server Components that show
 * the data, and the plan-limit event the upgrade dialog listens to.
 *
 * Navigation and refresh are separate requests issued from the client instead of `redirect`/`revalidatePath` inside
 * the action: those make the action response carry the re-rendered page, and with that response the form
 * intermittently stayed in its pending state (see README, "Server Actions vs REST vs WebSocket"). The refresh
 * also re-renders the layouts, so the navbar switcher picks up a new workspace.
 */
export function useActionFeedback(state: ActionState): void {
  const router = useRouter();
  useEffect(() => {
    if (state.planLimit) {
      emitPlanLimitExceeded({ message: state.planLimit.message, details: state.planLimit.details });
    }
    if (state.ok) {
      if (state.notice) toast.success(state.notice);
      startTransition(() => {
        if (state.redirectTo) router.push(state.redirectTo);
        router.refresh();
      });
    }
    // `state` is a new object per submit, which is exactly when this should run
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
}
