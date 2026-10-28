import type { ThreadResponse } from '@collab-docs/shared';

/** Threads created optimistically carry this id prefix until the api answers. */
export const PENDING_PREFIX = 'pending:';
export const isPending = (thread: Pick<ThreadResponse, 'id'>): boolean =>
  thread.id.startsWith(PENDING_PREFIX);

interface BlockGroup {
  blockId: string;
  threads: ThreadResponse[];
}

interface GroupedThreads {
  /** Threads on blocks that still exist, grouped by block in the order the blocks first got a thread. */
  blocks: BlockGroup[];
  /** Threads whose block was deleted from the document. */
  orphaned: ThreadResponse[];
}

/** Splits the threads the panel shows; `showResolved` decides whether closed threads are part of it. */
export function groupThreads(
  threads: readonly ThreadResponse[],
  showResolved: boolean,
): GroupedThreads {
  const blocks = new Map<string, ThreadResponse[]>();
  const orphaned: ThreadResponse[] = [];
  for (const thread of threads) {
    if (thread.resolved && !showResolved) continue;
    if (thread.orphaned) {
      orphaned.push(thread);
      continue;
    }
    const group = blocks.get(thread.blockId);
    if (group) group.push(thread);
    else blocks.set(thread.blockId, [thread]);
  }
  return {
    blocks: [...blocks].map(([blockId, grouped]) => ({ blockId, threads: grouped })),
    orphaned,
  };
}

/** Open threads per block: the number shown next to a block in the editor. */
export function openThreadCounts(threads: readonly ThreadResponse[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (thread.resolved || thread.orphaned) continue;
    counts.set(thread.blockId, (counts.get(thread.blockId) ?? 0) + 1);
  }
  return counts;
}
