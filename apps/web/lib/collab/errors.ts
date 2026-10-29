import {
  COLLAB_CLOSE,
  COLLAB_FINAL_CLOSE_CODES,
  type CollabRejectReason,
} from '@collab-docs/shared';
import { isApiError } from '@/lib/api/errors';

/** Why a collaboration session ended for good; the editor shows a screen for each. */
export type CollabErrorKind =
  | 'forbidden'
  | 'not-found'
  | 'deleted'
  /** An edit link that expired or was revoked (guests only). */
  | 'link-expired'
  | 'unavailable';

export interface CollabError {
  kind: CollabErrorKind;
  message: string;
}

/** What to do about a WebSocket close or a failed ticket request. */
type RecoveryDecision =
  | { action: 'stop'; error: CollabError }
  /** The ticket is no longer valid: fetch a fresh one and connect again. */
  | { action: 'new-ticket' }
  /** The server asked for less traffic: wait before trying again. */
  | { action: 'backoff' }
  /** A transient close; the provider's own reconnect loop handles it. */
  | { action: 'reconnect' };

const STOPPED: Record<CollabErrorKind, CollabError> = {
  forbidden: { kind: 'forbidden', message: 'You no longer have access to this document.' },
  'not-found': { kind: 'not-found', message: 'This document does not exist.' },
  deleted: { kind: 'deleted', message: 'This document was deleted.' },
  'link-expired': { kind: 'link-expired', message: 'This link has expired or was revoked.' },
  unavailable: {
    kind: 'unavailable',
    message: 'The real-time connection could not be established.',
  },
};

export const collabError = (kind: CollabErrorKind): CollabError => STOPPED[kind];

const stopped = (kind: CollabErrorKind): RecoveryDecision => ({
  action: 'stop',
  error: collabError(kind),
});

/**
 * The single place that turns a WebSocket close code into behaviour (spec §5). `y-websocket` 3.x already treats
 * 4400-4499 as permanent and reports them through its `closed` event; the decision here says what each code means.
 */
export function decideOnClose(code: number): RecoveryDecision {
  if (COLLAB_FINAL_CLOSE_CODES.includes(code)) {
    if (code === COLLAB_CLOSE.forbidden) return stopped('forbidden');
    if (code === COLLAB_CLOSE.notFound) return stopped('not-found');
    return stopped('deleted');
  }
  if (code === COLLAB_CLOSE.ticketInvalid) return { action: 'new-ticket' };
  if (code === COLLAB_CLOSE.rateLimited) return { action: 'backoff' };
  return { action: 'reconnect' };
}

/** What a failed `collab-ticket` request means: no access, or worth another try after a pause. */
export function decideOnTicketError(error: unknown): RecoveryDecision {
  if (isApiError(error)) {
    if (error.status === 403) return stopped('forbidden');
    if (error.status === 410) {
      return stopped(error.code === 'DOCUMENT_DELETED' ? 'deleted' : 'link-expired');
    }
    if (error.status === 404) return stopped('not-found');
    if (error.status === 429 || error.status >= 500 || error.code === 'NETWORK_ERROR') {
      return { action: 'backoff' };
    }
  }
  return stopped('unavailable');
}

const REJECTED: Record<CollabRejectReason, string> = {
  too_large: 'That change was too large to save and was undone.',
  document_too_large: 'This document has reached its size limit. The last change was undone.',
  invalid: 'A change could not be saved and was undone.',
};

/** What the editor tells the user when the server refused a local change and the document was reloaded. */
export const rejectionMessage = (reason: CollabRejectReason): string => REJECTED[reason];

/** One toast for refusals in a row (a full document refuses every keystroke): a new one replaces the shown one. */
export const REJECTION_TOAST_ID = 'collab-rejected';

/** Consecutive failed rounds (ticket or connection) before the session gives up and offers a manual retry. */
export const MAX_RECOVERY_ROUNDS = 5;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** 1 s, 2 s, 4 s ... capped; `round` counts from 1. */
export function backoffDelay(round: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, round - 1), BACKOFF_MAX_MS);
}
