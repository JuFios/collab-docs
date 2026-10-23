'use client';

import { type DocumentDetails, DOCUMENT_TITLE_MAX_LENGTH } from '@collab-docs/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSaveDocumentTitle } from '@/lib/documents/queries';
import { consumeTitleFocus } from '@/lib/documents/title-focus';

const SAVE_DEBOUNCE_MS = 700;

export type TitleSaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Inline title: typing is saved after a pause, on Enter, on blur and when leaving the page. A newly created
 * document opens with the field focused and selected. Remote renames are taken over unless the user is typing.
 */
export function DocumentTitle({
  workspaceId,
  document,
  editable,
  inputRef,
  onSaveState,
}: {
  workspaceId: string;
  document: Pick<DocumentDetails, 'id' | 'title'>;
  editable: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSaveState: (state: TitleSaveState) => void;
}) {
  const rename = useSaveDocumentTitle(workspaceId);
  const [draft, setDraft] = useState(document.title);
  const draftRef = useRef(draft);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mutate = rename.mutate;
  const documentId = document.id;

  useEffect(() => {
    if (dirty.current) return;
    setDraft(document.title);
    draftRef.current = document.title;
  }, [document.title]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    mutate(
      { id: documentId, title: draftRef.current.trim() },
      {
        onSuccess: () => onSaveState('saved'),
        onError: () => onSaveState('error'),
      },
    );
    onSaveState('saving');
  }, [documentId, mutate, onSaveState]);

  useEffect(() => {
    if (!editable || !consumeTitleFocus(documentId)) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [documentId, editable, inputRef]);

  // leaving the page must not drop an edit that is still waiting for its pause
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);

  if (!editable) {
    return (
      <h2 className="min-w-0 truncate text-2xl font-semibold">{document.title || 'Untitled'}</h2>
    );
  }
  return (
    <input
      ref={inputRef}
      value={draft}
      maxLength={DOCUMENT_TITLE_MAX_LENGTH}
      placeholder="Untitled"
      aria-label="Document title"
      onChange={(event) => {
        draftRef.current = event.target.value;
        dirty.current = true;
        setDraft(event.target.value);
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
      }}
      onBlur={flush}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          flush();
          event.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-2xl font-semibold outline-none hover:border-input focus-visible:border-input focus-visible:ring-2 focus-visible:ring-ring"
    />
  );
}
