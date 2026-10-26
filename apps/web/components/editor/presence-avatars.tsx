'use client';

import { type PresenceUser, initialsOf } from '@/lib/collab/presence';
import { safeColor } from './caret';

const MAX_VISIBLE = 4;

/** Who else is in the document. Colours match their cursors in the text. */
export function PresenceAvatars({ users }: { users: PresenceUser[] }) {
  if (users.length === 0) return null;
  const visible = users.slice(0, MAX_VISIBLE);
  const hidden = users.length - visible.length;
  return (
    <ul
      aria-label="People in this document"
      data-testid="presence"
      className="flex shrink-0 items-center -space-x-2"
    >
      {visible.map((user) => (
        <li
          key={user.id}
          title={user.name}
          aria-label={user.name}
          style={{ backgroundColor: safeColor(user.color) }}
          className="grid h-7 w-7 place-items-center rounded-full border-2 border-background text-xs font-medium text-white"
        >
          <span aria-hidden>{initialsOf(user.name)}</span>
        </li>
      ))}
      {hidden > 0 ? (
        <li
          aria-label={`${hidden} more`}
          className="grid h-7 w-7 place-items-center rounded-full border-2 border-background bg-muted text-xs"
        >
          +{hidden}
        </li>
      ) : null}
    </ul>
  );
}
