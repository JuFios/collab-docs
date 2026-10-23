import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createErrorHandlers } from '../api/error-handler';
import { isApiError } from '../api/errors';
import { emitPlanLimitExceeded } from '../api/plan-limit-events';

export function createQueryClient(): QueryClient {
  const handlers = createErrorHandlers({
    toastError: (message, description) => toast.error(message, { description }),
    onPlanLimit: emitPlanLimitExceeded,
  });
  return new QueryClient({
    queryCache: new QueryCache({ onError: handlers.onQueryError }),
    mutationCache: new MutationCache({ onError: handlers.onMutationError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) =>
          // client errors will not succeed on retry; network and 5xx get two more tries
          failureCount < 2 &&
          (!isApiError(error) || error.status >= 500 || error.code === 'NETWORK_ERROR'),
      },
    },
  });
}
