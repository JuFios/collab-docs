'use client';

import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { cn } from '@/lib/utils';
import type { SlashItem } from './slash-items';

export interface SlashMenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

export type SlashMenuProps = SuggestionProps<SlashItem, SlashItem>;

/** The popup behind "/": arrow keys move, Enter picks, Escape is handled by the suggestion plugin. */
export const SlashMenu = forwardRef<SlashMenuHandle, SlashMenuProps>(function SlashMenu(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);

  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (items.length === 0) return false;
      if (event.key === 'ArrowDown') {
        setSelected((index) => (index + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((index) => (index + items.length - 1) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="rounded-md border bg-popover p-2 text-sm text-muted-foreground shadow-md">
        No matching blocks
      </div>
    );
  }
  return (
    <div
      role="listbox"
      aria-label="Insert a block"
      className="max-h-72 w-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={index === selected}
          // keep the editor selection: a click must not blur the text before the command runs
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => command(item)}
          className={cn(
            'flex w-full items-center rounded px-2 py-1.5 text-left text-sm',
            index === selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
          )}
        >
          {item.title}
        </button>
      ))}
    </div>
  );
});
