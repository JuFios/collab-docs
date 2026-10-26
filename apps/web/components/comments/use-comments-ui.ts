'use client';

import type { ThreadResponse } from '@collab-docs/shared';
import type { Editor } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BlockCommentsController } from '@/components/editor/block-comments';
import { useThreads } from '@/lib/comments/queries';
import { openThreadCounts } from '@/lib/comments/threads';
import { scrollToBlock } from './block-labels';

/** How long the block a thread points at stays highlighted. */
const HIGHLIGHT_MS = 2_500;

/**
 * Everything that ties the comments panel to the editor on a document page: the marker controller, the editor
 * instance, the thread being started or looked at, and the `?thread=` link. The page keeps only where the panel is
 * shown.
 */
export function useCommentsUi({
  documentId,
  canComment,
  initialThreadId,
  openPanel,
}: {
  documentId: string;
  canComment: boolean;
  /** Thread to show on arrival (from a notification or an email). */
  initialThreadId: string | null;
  /** Must be stable; shows the comments panel. */
  openPanel: () => void;
}) {
  const controller = useMemo(() => new BlockCommentsController(), []);
  const threads = useThreads(documentId);
  const { refetch } = threads;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [composeBlockId, setComposeBlockId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const flash = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handledLink = useRef<string | null>(null);

  useEffect(() => () => clearTimeout(flash.current), []);

  const reveal = useCallback(
    (blockId: string) => {
      if (!editor) return;
      scrollToBlock(editor, blockId);
      controller.update({ highlighted: blockId });
      clearTimeout(flash.current);
      flash.current = setTimeout(() => controller.update({ highlighted: null }), HIGHLIGHT_MS);
    },
    [editor, controller],
  );

  const select = useCallback(
    (thread: ThreadResponse) => {
      setActiveThreadId(thread.id);
      if (!thread.orphaned) reveal(thread.blockId);
    },
    [reveal],
  );

  useEffect(() => {
    controller.update({ counts: openThreadCounts(threads.data ?? []), canComment });
  }, [controller, threads.data, canComment]);

  useEffect(() => {
    controller.onAdd = (blockId) => {
      setComposeBlockId(blockId);
      openPanel();
    };
    controller.onOpen = (blockId) => {
      openPanel();
      const thread = threads.data?.find((item) => item.blockId === blockId && !item.resolved);
      if (thread) select(thread);
    };
  }, [controller, threads.data, select, openPanel]);

  useEffect(() => {
    if (!initialThreadId || handledLink.current === initialThreadId || !editor || !threads.data) {
      return;
    }
    handledLink.current = initialThreadId;
    void (async () => {
      let thread = threads.data.find((item) => item.id === initialThreadId);
      if (!thread) {
        // a thread written after this page loaded: ask once more before calling it gone
        const fresh = await refetch();
        thread = fresh.data?.find((item) => item.id === initialThreadId);
      }
      if (!thread) {
        toast('That comment is not available any more.');
        return;
      }
      openPanel();
      select(thread);
    })();
  }, [initialThreadId, editor, threads.data, refetch, openPanel, select]);

  return {
    controller,
    setEditor,
    editor,
    composeBlockId,
    endCompose: useCallback(() => setComposeBlockId(null), []),
    activeThreadId,
    select,
    openCount: threads.data?.filter((thread) => !thread.resolved).length ?? 0,
  };
}
