'use client';

import { useEffect, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import { type PresenceUser, collectPresence } from './presence';

/** The other participants of the document, kept in step with the provider's awareness. */
export function usePresence(provider: WebsocketProvider | null): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    if (!provider) {
      setUsers([]);
      return;
    }
    const awareness = provider.awareness;
    const update = () => {
      const next = collectPresence(awareness.getStates(), awareness.clientID);
      setUsers((current) =>
        current.length === next.length &&
        current.every((user, index) => user.id === next[index]?.id)
          ? current
          : next,
      );
    };
    update();
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [provider]);

  return users;
}
