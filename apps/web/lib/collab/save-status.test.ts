import { describe, expect, it } from 'vitest';
import { type SaveStatusInput, deriveSaveStatus } from './save-status';

const base: SaveStatusInput = {
  connection: 'connected',
  synced: true,
  hasUnsyncedChanges: false,
  online: true,
  title: 'idle',
};

describe('deriveSaveStatus', () => {
  it('is saved only when the server reported everything stored', () => {
    expect(deriveSaveStatus(base)).toBe('saved');
    expect(deriveSaveStatus({ ...base, hasUnsyncedChanges: true })).toBe('saving');
  });

  it('shows offline when the browser is offline or the socket dropped', () => {
    expect(deriveSaveStatus({ ...base, online: false })).toBe('offline');
    expect(deriveSaveStatus({ ...base, connection: 'disconnected', synced: false })).toBe(
      'offline',
    );
    expect(
      deriveSaveStatus({ ...base, connection: 'disconnected', hasUnsyncedChanges: true }),
    ).toBe('offline');
  });

  it('shows connecting before the first sync', () => {
    expect(deriveSaveStatus({ ...base, connection: 'connecting', synced: false })).toBe(
      'connecting',
    );
    expect(deriveSaveStatus({ ...base, synced: false })).toBe('connecting');
  });

  it('folds the title save into the same status', () => {
    expect(deriveSaveStatus({ ...base, title: 'saving' })).toBe('saving');
    expect(deriveSaveStatus({ ...base, title: 'saved' })).toBe('saved');
    expect(deriveSaveStatus({ ...base, title: 'error' })).toBe('error');
  });
});
