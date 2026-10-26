'use client';

import {
  COMMENT_BODY_MAX_LENGTH,
  type MentionableUser,
  createCommentInputSchema,
} from '@collab-docs/shared';
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  type PickedMention,
  findMentionTrigger,
  insertMention,
  serializeBody,
} from '@/lib/comments/mentions';
import { useMentionable } from '@/lib/comments/queries';
import { cn } from '@/lib/utils';

export interface ComposerValue {
  /** The body as the api stores it: names picked from the autocomplete are `@[user id]` tokens. */
  body: string;
  mentions: PickedMention[];
}

/** Everything over this share of the limit starts showing the counter. */
const COUNTER_FROM = 0.8;

/**
 * Textarea with `@` autocomplete. The user sees and edits `@Ann Lee`; on submit the names that came from the list
 * become `@[id]` tokens (`serializeBody`), so the api never has to guess who a name refers to. Submitting clears the
 * field at once (the comment appears optimistically); if the request fails `onSubmit` resolves `false` and the text
 * comes back.
 */
export function CommentComposer({
  documentId,
  label,
  submitLabel = 'Comment',
  placeholder = 'Write a comment… use @ to mention someone',
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  documentId: string;
  /** Accessible name of the field; the page can hold many composers. */
  label: string;
  submitLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit: (value: ComposerValue) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<PickedMention[]>([]);
  const [caret, setCaret] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  const listId = `${ids}-mentions`;
  const errorId = `${ids}-error`;

  const trigger = findMentionTrigger(text, caret);
  // Escape closes the list for that `@` only; typing on, or another `@`, opens it again
  const open = trigger !== null && trigger.start !== dismissedAt;
  const matches = useMentionable(documentId, trigger?.query ?? '', open);
  const options: MentionableUser[] = open ? (matches.data ?? []) : [];
  const highlighted = Math.min(active, Math.max(options.length - 1, 0));

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  // after a name was inserted the caret belongs behind it; the browser would put it at the end of the text
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    field.current?.focus();
    field.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  function sync(target: HTMLTextAreaElement) {
    setCaret(target.selectionStart);
  }

  function change(event: ChangeEvent<HTMLTextAreaElement>) {
    setText(event.target.value);
    setError(null);
    setActive(0);
    sync(event.target);
  }

  function pick(index: number) {
    const user = options[index];
    if (!trigger || !user) return;
    const next = insertMention(text, trigger, caret, user.name);
    setText(next.text);
    setPicked((current) => [...current, { id: user.id, name: user.name }]);
    setCaret(next.caret);
    setActive(0);
    pendingCaret.current = next.caret;
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && options.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : options.length - 1;
        setActive((highlighted + step) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(highlighted);
        return;
      }
    }
    if (open && trigger && event.key === 'Escape') {
      // close the list, not the panel the composer lives in
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(trigger.start);
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const body = serializeBody(text, picked);
    const parsed = createCommentInputSchema.safeParse({ body });
    if (!parsed.success) {
      setError(
        body.trim() === ''
          ? 'Write something first.'
          : `A comment can have at most ${COMMENT_BODY_MAX_LENGTH} characters.`,
      );
      return;
    }
    const snapshot = { text, picked };
    setText('');
    setPicked([]);
    setCaret(0);
    setError(null);
    const ok = await onSubmit({ body: parsed.data.body, mentions: picked });
    if (!ok) {
      // keep whatever was typed in the meantime; otherwise bring the failed comment back
      setText((current) => (current === '' ? snapshot.text : current));
      setPicked((current) => (current.length === 0 ? snapshot.picked : current));
    }
  }

  const length = serializeBody(text, picked).trim().length;
  const showCounter = length >= COMMENT_BODY_MAX_LENGTH * COUNTER_FROM;

  return (
    <form onSubmit={submit} className="grid gap-2" noValidate>
      <div className="relative">
        <textarea
          ref={field}
          value={text}
          rows={3}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open && options.length > 0}
          aria-controls={open && options.length > 0 ? listId : undefined}
          aria-activedescendant={
            open && options.length > 0 ? `${listId}-${highlighted}` : undefined
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder={placeholder}
          onChange={change}
          onKeyDown={keyDown}
          onKeyUp={(event) => sync(event.currentTarget)}
          onClick={(event) => sync(event.currentTarget)}
          className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {open && options.length > 0 ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="People to mention"
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
          >
            {options.map((user, index) => (
              <li
                key={user.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                // mousedown, not click: the textarea must keep its focus and caret
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(index);
                }}
                className={cn(
                  'grid cursor-pointer gap-0 rounded-sm px-2 py-1.5',
                  index === highlighted && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="font-medium">{user.name}</span>
                <span className="text-xs text-muted-foreground">{user.email}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {open && matches.data
          ? matches.data.length === 0
            ? 'No one to mention'
            : `${matches.data.length} people to mention`
          : ''}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {showCounter ? (
          <span
            className={cn(
              'text-xs text-muted-foreground',
              length > COMMENT_BODY_MAX_LENGTH && 'text-destructive',
            )}
          >
            {length} / {COMMENT_BODY_MAX_LENGTH}
          </span>
        ) : null}
        <span className="ml-auto flex gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={text.trim() === ''}>
            {submitLabel}
          </Button>
        </span>
      </div>
    </form>
  );
}
