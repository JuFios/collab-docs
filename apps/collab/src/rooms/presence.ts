import { createHash } from 'node:crypto';

/** White text sits on these (initials in the avatars, names on the cursors), so each reaches 4.5:1 against white. */
export const PRESENCE_PALETTE = [
  '#e11d48',
  '#c2410c',
  '#a16207',
  '#15803d',
  '#0f766e',
  '#0369a1',
  '#4f46e5',
  '#9333ea',
  '#c026d3',
  '#475569',
] as const;

/** A stable colour per user, so a collaborator keeps their cursor colour across documents and sessions. */
export function presenceColor(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  return PRESENCE_PALETTE[(digest[0] ?? 0) % PRESENCE_PALETTE.length] ?? PRESENCE_PALETTE[0];
}
