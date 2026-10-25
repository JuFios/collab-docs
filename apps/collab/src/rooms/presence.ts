import { createHash } from 'node:crypto';

const PALETTE = [
  '#e11d48',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0d9488',
  '#0284c7',
  '#4f46e5',
  '#9333ea',
  '#c026d3',
  '#475569',
] as const;

/** A stable colour per user, so a collaborator keeps their cursor colour across documents and sessions. */
export function presenceColor(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  return PALETTE[(digest[0] ?? 0) % PALETTE.length] ?? PALETTE[0];
}
