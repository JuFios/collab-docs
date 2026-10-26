import type { ThreadResponse } from '@collab-docs/shared';
import { describe, expect, it } from 'vitest';
import { groupThreads, isPending, openThreadCounts } from './threads';

function thread(id: string, blockId: string, patch: Partial<ThreadResponse> = {}): ThreadResponse {
  return {
    id,
    documentId: 'doc',
    blockId,
    orphaned: false,
    resolved: false,
    resolvedAt: null,
    createdAt: '2030-01-01T00:00:00.000Z',
    comments: [],
    ...patch,
  };
}

describe('groupThreads', () => {
  const threads = [
    thread('a', 'b1'),
    thread('b', 'b2', { resolved: true }),
    thread('c', 'b1'),
    thread('d', 'gone', { orphaned: true }),
    thread('e', 'gone2', { orphaned: true, resolved: true }),
  ];

  it('groups open threads by block and sets orphaned ones apart', () => {
    const grouped = groupThreads(threads, false);
    expect(grouped.blocks).toEqual([{ blockId: 'b1', threads: [threads[0], threads[2]] }]);
    expect(grouped.orphaned).toEqual([threads[3]]);
  });

  it('adds resolved threads on request', () => {
    const grouped = groupThreads(threads, true);
    expect(grouped.blocks.map((group) => group.blockId)).toEqual(['b1', 'b2']);
    expect(grouped.orphaned).toHaveLength(2);
  });
});

describe('openThreadCounts', () => {
  it('counts only open threads of blocks that exist', () => {
    const counts = openThreadCounts([
      thread('a', 'b1'),
      thread('b', 'b1'),
      thread('c', 'b2', { resolved: true }),
      thread('d', 'b3', { orphaned: true }),
    ]);
    expect([...counts]).toEqual([['b1', 2]]);
  });
});

describe('isPending', () => {
  it('recognises optimistic threads', () => {
    expect(isPending(thread('pending:1', 'b'))).toBe(true);
    expect(isPending(thread('1', 'b'))).toBe(false);
  });
});
