'use client';

import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { nextFocus } from './keyboard';

/**
 * Wraps the search field and its results (both rendered on the server) and adds the arrow keys: Down from the
 * field enters the list, Up/Down move through it, Up from the first result and Escape return to the field.
 */
export function SearchKeyboardScope({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const scope = root.current;
    if (!scope) return;
    const input = scope.querySelector<HTMLInputElement>('[data-search-input]');
    const results = [...scope.querySelectorAll<HTMLElement>('[data-search-result]')];
    const focused = results.indexOf(document.activeElement as HTMLElement);
    const onInput = document.activeElement === input;
    if (focused < 0 && !onInput) return;

    const target = nextFocus(event.key, focused < 0 ? null : focused, results.length);
    if (target === null) return;
    event.preventDefault();
    (target === 'input' ? input : results[target])?.focus();
  }

  // the handler only reacts to key events bubbling up from the field and the links inside
  return (
    <div ref={root} onKeyDown={onKeyDown} className="grid gap-4">
      {children}
    </div>
  );
}
