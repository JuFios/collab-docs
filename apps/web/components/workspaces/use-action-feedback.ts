'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { emitPlanLimitExceeded } from '@/lib/api/plan-limit-events';
import type { ActionState } from '@/lib/workspaces/action-state';

/**
 * Side effects of a finished action in the browser: a success toast and the plan-limit event the upgrade dialog
 * listens to. The page itself is already fresh: the action redirected, or revalidated the route and its response
 * carried the new render.
 */
export function useActionFeedback(state: ActionState): void {
  useEffect(() => {
    if (state.planLimit) {
      emitPlanLimitExceeded({ message: state.planLimit.message, details: state.planLimit.details });
    }
    if (state.ok && state.notice) toast.success(state.notice);
    // `state` is a new object per submit, which is exactly when this should run
  }, [state]);
}
