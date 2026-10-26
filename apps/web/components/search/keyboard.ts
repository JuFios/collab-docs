export type FocusTarget = 'input' | number | null;

/**
 * Where the arrow keys move the focus on the search page: from the field to the first result, between results,
 * and from the first result back to the field. `index` is the focused result (`null` when the field has the focus).
 */
export function nextFocus(key: string, index: number | null, count: number): FocusTarget {
  if (key === 'ArrowDown') {
    if (count === 0) return null;
    if (index === null) return 0;
    return index < count - 1 ? index + 1 : null;
  }
  if (key === 'ArrowUp') {
    if (index === null) return null;
    return index === 0 ? 'input' : index - 1;
  }
  if (key === 'Escape' && index !== null) return 'input';
  return null;
}
