import type { ConfigService } from '@nestjs/config';
import type { Access } from '@collab-docs/shared';
import type { AppConfig, PinoLogger } from '@collab-docs/nest';
import type { CollabMetrics } from '../metrics/collab-metrics.service';
import type { DocRoom, RoomConnection } from '../rooms/doc-room';
import type { RoomManager, Session } from '../rooms/room-manager';
import { AccessReevaluator } from './access-reevaluator.service';
import type { AccessOutcome, AccessService } from './access.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/** A room that remembers the access level it was given. */
function fakeRoom(initial: Access) {
  let level = initial;
  const room = {
    accessOf: () => level,
    setAccess: jest.fn((_conn: RoomConnection, next: Access) => {
      level = next;
    }),
    kick: jest.fn(),
  };
  return {
    room: room as unknown as DocRoom,
    level: () => level,
    setAccess: room.setAccess,
    kick: room.kick,
  };
}

function setup(initial: Access = 'EDIT') {
  const conn = { id: 'conn-1' } as RoomConnection;
  const { room, level, setAccess, kick } = fakeRoom(initial);
  const session = {
    conn,
    room,
    documentId: 'doc-1',
    identity: { userId: 'user-1' },
    workspaceId: 'workspace-1',
  } as Session;
  const access = { resolve: jest.fn() };
  const rooms = { matching: () => [session] } as unknown as RoomManager;
  const reevaluator = new AccessReevaluator(
    {} as ConfigService<AppConfig, true>,
    access as unknown as AccessService,
    rooms,
    { accessChanged: jest.fn() } as unknown as CollabMetrics,
    { warn: jest.fn() } as unknown as PinoLogger,
  );
  return { reevaluator, access, level, setAccess, kick, conn };
}

describe('AccessReevaluator', () => {
  it('applies the decision of the newest check, not the one that answers last', async () => {
    const { reevaluator, access, level, setAccess, conn } = setup();
    const stale = deferred<AccessOutcome>();
    const fresh = deferred<AccessOutcome>();
    access.resolve.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const first = reevaluator.reevaluate({});
    const second = reevaluator.reevaluate({});
    fresh.resolve({ status: 'ok', access: 'VIEW', workspaceId: 'workspace-1' });
    await second;
    stale.resolve({ status: 'ok', access: 'EDIT', workspaceId: 'workspace-1' });
    await first;

    expect(level()).toBe('VIEW');
    expect(setAccess).toHaveBeenLastCalledWith(conn, 'VIEW');
  });

  it('does not close a connection when a newer check granted access', async () => {
    const { reevaluator, access, level, kick } = setup();
    const stale = deferred<AccessOutcome>();
    const fresh = deferred<AccessOutcome>();
    access.resolve.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const first = reevaluator.reevaluate({});
    const second = reevaluator.reevaluate({});
    fresh.resolve({ status: 'ok', access: 'EDIT', workspaceId: 'workspace-1' });
    await second;
    stale.resolve({ status: 'forbidden' });
    await first;

    expect(level()).toBe('EDIT');
    expect(kick).not.toHaveBeenCalled();
  });
});
