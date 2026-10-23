import { generateKeyBetween } from 'fractional-indexing';

/**
 * Order key strictly between `before` and `after` (`null` = open end). Keys are plain ASCII, so bytewise
 * (`COLLATE "C"`) and JavaScript string order agree and no rebalancing is ever needed.
 * Throws when the neighbours are equal or inverted.
 */
export function positionBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}
