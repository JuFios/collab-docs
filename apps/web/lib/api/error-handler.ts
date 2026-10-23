import { ApiError, isApiError } from './errors';

export interface ErrorHandlerDeps {
  toastError: (message: string, description?: string) => void;
  onPlanLimit: (detail: { message: string; correlationId?: string; details?: unknown }) => void;
}

/** Statuses a query's own UI renders (ForbiddenState, not-found, redirect to login); no toast for these. */
const RENDERED_BY_UI = new Set([401, 403, 404]);

function describe(error: ApiError): string | undefined {
  return error.correlationId ? `Reference: ${error.correlationId}` : undefined;
}

function messageFor(error: ApiError): string {
  if (error.code === 'RATE_LIMITED')
    return 'Too many requests. Please wait a moment and try again.';
  if (error.code === 'NETWORK_ERROR') return 'Cannot reach the server. Check your connection.';
  if (error.status >= 500) return 'Something went wrong on our side. Please try again.';
  return error.message;
}

/**
 * The single place where `ApiError`s become user feedback. The 401 refresh-and-retry happens earlier, inside
 * the client; a 401 that reaches this point has already sent the user to the login page.
 */
export function createErrorHandlers(deps: ErrorHandlerDeps) {
  return {
    onQueryError(error: unknown): void {
      if (!isApiError(error) || RENDERED_BY_UI.has(error.status)) return;
      deps.toastError(messageFor(error), describe(error));
    },
    onMutationError(error: unknown): void {
      if (!isApiError(error)) {
        deps.toastError('Something went wrong. Please try again.');
        return;
      }
      if (error.status === 401) return;
      if (error.code === 'PLAN_LIMIT_EXCEEDED') {
        deps.onPlanLimit({
          message: error.message,
          correlationId: error.correlationId,
          details: error.details,
        });
        return;
      }
      if (error.status === 403) {
        deps.toastError("You don't have permission to do that.", describe(error));
        return;
      }
      deps.toastError(messageFor(error), describe(error));
    },
  };
}
