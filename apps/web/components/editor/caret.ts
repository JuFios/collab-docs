const COLOR_PATTERN = /^#[0-9a-f]{3,8}$/i;
const FALLBACK_COLOR = '#64748b';

/** Colours come from the server's awareness state; anything that is not a plain hex colour is replaced. */
export const safeColor = (value: unknown): string =>
  typeof value === 'string' && COLOR_PATTERN.test(value) ? value : FALLBACK_COLOR;

/**
 * The remote cursor: a coloured bar. The name is drawn by CSS from `data-name` (`.collab-caret::after`), so it is
 * neither selectable nor part of the document text that readers, copy and paste and tests see.
 */
export function renderCaret(user: Record<string, unknown>): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'collab-caret';
  caret.style.setProperty('--caret-color', safeColor(user.color));
  caret.dataset.name = typeof user.name === 'string' ? user.name : '';
  return caret;
}

export function renderSelection(user: Record<string, unknown>) {
  return {
    class: 'collab-selection',
    style: `background-color: color-mix(in srgb, ${safeColor(user.color)} 25%, transparent)`,
  };
}
