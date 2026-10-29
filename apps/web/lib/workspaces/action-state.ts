import {
  PLAN_CATALOG,
  type PlanLimitDetails,
  type PlanTier,
  planLimitDetailsSchema,
} from '@collab-docs/shared';
import { ApiError } from '@/lib/api/errors';
import { rateLimitMessage } from '@/lib/auth/form-state';

/** Result of a workspace Server Action; plain data so it crosses the server/client boundary. */
export interface ActionState {
  /** Field name -> messages. */
  fieldErrors?: Record<string, string[]>;
  formError?: string;
  /** Set when the api refused because of a plan limit; the client forwards it to the upgrade dialog. */
  planLimit?: { message: string; details: PlanLimitDetails };
  /** Echoed back so a failed submit does not clear the inputs. */
  values?: Record<string, string>;
  ok?: boolean;
  /** Short confirmation for the user (toast) after a successful submit. */
  notice?: string;
}

const PLAN_NAMES: Record<PlanTier, string> = { FREE: 'Free', PRO: 'Pro', TEAM: 'Team' };

const KIND_NOUNS = {
  members: 'members (pending invitations count too)',
  documents: 'documents',
  storage: 'bytes of storage',
} as const;

export function planLimitMessage(details: PlanLimitDetails): string {
  const plan = PLAN_NAMES[details.plan] ?? details.plan;
  const upgrade = PLAN_CATALOG[details.plan].priceCents < PLAN_CATALOG.TEAM.priceCents;
  const limit = `The ${plan} plan allows ${details.limit.toLocaleString('en-US')} ${KIND_NOUNS[details.kind]} and ${
    details.current >= details.limit ? 'all of them are' : `${details.current} are`
  } in use.`;
  const hint =
    details.kind === 'members'
      ? 'Revoke a pending invitation or remove a member to free a slot'
      : 'Delete something you no longer need';
  return `${limit} ${hint}${upgrade ? ', or upgrade the plan' : ''}.`;
}

/** Maps an api failure to form state: field errors, plan limits, rate limits and everything else. */
export function failureState(error: unknown, values?: Record<string, string>): ActionState {
  if (!(error instanceof ApiError)) throw error;
  const base = values ? { values } : {};
  switch (error.code) {
    case 'VALIDATION_FAILED':
      return {
        ...base,
        fieldErrors: error.fieldErrors,
        formError: 'Please fix the highlighted fields.',
      };
    case 'PLAN_LIMIT_EXCEEDED': {
      const details = planLimitDetailsSchema.safeParse(error.details);
      const message = details.success ? planLimitMessage(details.data) : error.message;
      return {
        ...base,
        formError: message,
        ...(details.success ? { planLimit: { message, details: details.data } } : {}),
      };
    }
    case 'RATE_LIMITED':
      return { ...base, formError: rateLimitMessage(undefined) };
    case 'FORBIDDEN':
      return { ...base, formError: error.message };
    case 'NOT_FOUND':
      return { ...base, formError: 'This no longer exists. Reload the page and try again.' };
    case 'NETWORK_ERROR':
      return { ...base, formError: 'We could not reach the server. Please try again.' };
    default:
      return {
        ...base,
        formError: error.status >= 500 ? 'Something went wrong. Please try again.' : error.message,
      };
  }
}
