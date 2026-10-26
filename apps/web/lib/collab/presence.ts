import { z } from 'zod';

/** Who else is in the document, as the server announces it in the awareness state. */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

const awarenessUserSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), color: z.string() }),
});

/**
 * Other participants from the awareness states. The server replaces `user` with the authenticated identity, so
 * the names and colours can be trusted for display; the same person in several tabs counts once.
 */
export function collectPresence(
  states: ReadonlyMap<number, unknown>,
  selfClientId: number,
): PresenceUser[] {
  const users = new Map<string, PresenceUser>();
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const parsed = awarenessUserSchema.safeParse(state);
    if (parsed.success && !users.has(parsed.data.user.id)) {
      users.set(parsed.data.user.id, parsed.data.user);
    }
  }
  return [...users.values()];
}

export const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] ?? '?'];
  return letters
    .map((part) => [...(part ?? '?')][0] ?? '?')
    .join('')
    .toUpperCase();
};
