import { positionBetween as keyBetween } from '@collab-docs/shared';
import { AppException } from '@collab-docs/nest';

/** `positionBetween` that reports equal or inverted neighbours (the caller's view of the siblings is stale) as 409. */
export function positionBetween(before: string | null, after: string | null): string {
  try {
    return keyBetween(before, after);
  } catch {
    throw new AppException('CONFLICT', 'The requested position is no longer valid');
  }
}
