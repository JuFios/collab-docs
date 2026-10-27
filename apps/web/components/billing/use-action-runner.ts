'use client';

import { useState, useTransition } from 'react';
import { useActionFeedback } from '@/components/workspaces/use-action-feedback';
import type { ActionState } from '@/lib/workspaces/action-state';

/**
 * Runs a Server Action from an event handler (a button, not a `<form>`) and applies its result the way the form
 * hooks do: toast, navigation, refresh and the plan-limit event. The failure message stays in `state`.
 */
export function useActionRunner<Args>(run: (args: Args) => Promise<ActionState>) {
  const [state, setState] = useState<ActionState>({});
  const [pending, startTransition] = useTransition();
  useActionFeedback(state);

  function execute(args: Args) {
    startTransition(async () => {
      setState(await run(args));
    });
  }
  return { state, pending, execute };
}
