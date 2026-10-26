import type { CollabStatus } from './use-collab-connection';

export type TitleSaveState = 'idle' | 'saving' | 'saved' | 'error';

export type SaveStatus = 'connecting' | 'saved' | 'saving' | 'offline' | 'error';

export interface SaveStatusInput {
  connection: CollabStatus;
  synced: boolean;
  /** Local changes the server has not reported as stored (`persisted`). */
  hasUnsyncedChanges: boolean;
  online: boolean;
  title: TitleSaveState;
}

export const SAVE_STATUS_LABELS: Record<SaveStatus, string> = {
  connecting: 'Connecting…',
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Offline — changes will sync on reconnect',
  error: 'Could not save',
};

/**
 * "Saved" means the server wrote everything to the database, not that the WebSocket accepted the bytes:
 * `y-websocket` has no acknowledgements, so `hasUnsyncedChanges` compares the local state vector with the one
 * the server reported as persisted.
 */
export function deriveSaveStatus(input: SaveStatusInput): SaveStatus {
  if (!input.online || input.connection === 'disconnected') return 'offline';
  if (input.connection === 'connecting' || !input.synced) return 'connecting';
  if (input.title === 'error') return 'error';
  if (input.title === 'saving' || input.hasUnsyncedChanges) return 'saving';
  return 'saved';
}
