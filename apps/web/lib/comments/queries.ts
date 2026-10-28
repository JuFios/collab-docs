'use client';

import {
  type CommentResponse,
  type MentionWarning,
  type MentionableUser,
  type ThreadResponse,
  commentWriteResultSchema,
  mentionableUserSchema,
  threadSchema,
  threadWriteResultSchema,
} from '@collab-docs/shared';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { apiClient } from '@/lib/api/client';
import type { PickedMention } from './mentions';
import { PENDING_PREFIX } from './threads';

export interface Viewer {
  id: string;
  name: string;
}

const threadsKey = (documentId: string) => ['threads', documentId] as const;
const mentionableKey = (documentId: string, q: string) => ['mentionable', documentId, q] as const;

/** Every thread of the document, open and resolved; the panel filters, so toggling the filter is instant. */
export function useThreads(documentId: string) {
  return useQuery({
    queryKey: threadsKey(documentId),
    queryFn: ({ signal }) =>
      apiClient.request(`/documents/${documentId}/threads?status=all`, {
        schema: z.array(threadSchema),
        signal,
      }),
  });
}

/** People who can be mentioned, narrowed by what has been typed after the `@`. */
export function useMentionable(documentId: string, q: string, enabled: boolean) {
  return useQuery<MentionableUser[]>({
    queryKey: mentionableKey(documentId, q),
    enabled,
    staleTime: 60_000,
    // keep the previous matches on screen while the next ones load, so the list does not flicker per keystroke
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) =>
      apiClient.request(`/documents/${documentId}/mentionable?q=${encodeURIComponent(q)}`, {
        schema: z.array(mentionableUserSchema),
        signal,
      }),
  });
}

function warn(warnings: readonly MentionWarning[]): void {
  if (warnings.length === 0) return;
  const skipped = warnings.filter((warning) => warning.code === 'MENTION_IGNORED').length;
  if (skipped > 0) {
    toast.warning(
      skipped === 1
        ? 'One person was not mentioned: they cannot open this document.'
        : `${skipped} people were not mentioned: they cannot open this document.`,
    );
  }
  if (warnings.some((warning) => warning.code === 'MENTION_LIMIT')) {
    toast.warning('Only the first 20 mentions in a comment notify anyone.');
  }
}

let pendingCounter = 0;
const pendingId = () => `${PENDING_PREFIX}${++pendingCounter}`;

function optimisticComment(
  viewer: Viewer,
  body: string,
  mentions: PickedMention[],
): CommentResponse {
  return {
    id: pendingId(),
    author: viewer,
    body,
    deleted: false,
    mentions: mentions.map((mention) => ({ userId: mention.id, name: mention.name })),
    createdAt: new Date().toISOString(),
    editedAt: null,
  };
}

/**
 * Optimistic write as the TanStack Query guide describes it: stop in-flight refetches, apply the change to the
 * cache, keep the previous list for a rollback, and refetch once the request settled.
 */
async function applyOptimistic(
  queryClient: QueryClient,
  documentId: string,
  update: (threads: ThreadResponse[]) => ThreadResponse[],
) {
  const key = threadsKey(documentId);
  await queryClient.cancelQueries({ queryKey: key });
  const previous = queryClient.getQueryData<ThreadResponse[]>(key);
  if (previous) queryClient.setQueryData<ThreadResponse[]>(key, update(previous));
  return { previous };
}

type Rollback = { previous: ThreadResponse[] | undefined };

function useRollback(documentId: string) {
  const queryClient = useQueryClient();
  return {
    queryClient,
    onError: (_error: unknown, _variables: unknown, context: Rollback | undefined) => {
      if (context?.previous) queryClient.setQueryData(threadsKey(documentId), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: threadsKey(documentId) }),
  };
}

export interface NewComment {
  /** Body as the api stores it (`@[id]` tokens). */
  body: string;
  mentions: PickedMention[];
}

export function useCreateThread(documentId: string, viewer: Viewer) {
  const { queryClient, onError, onSettled } = useRollback(documentId);
  return useMutation({
    mutationFn: ({ blockId, body }: NewComment & { blockId: string }) =>
      apiClient.request(`/documents/${documentId}/threads`, {
        method: 'POST',
        body: { blockId, body },
        schema: threadWriteResultSchema,
      }),
    onMutate: ({ blockId, body, mentions }): Promise<Rollback> =>
      applyOptimistic(queryClient, documentId, (threads) => [
        ...threads,
        {
          id: pendingId(),
          documentId,
          blockId,
          orphaned: false,
          resolved: false,
          resolvedAt: null,
          createdAt: new Date().toISOString(),
          comments: [optimisticComment(viewer, body, mentions)],
        },
      ]),
    onSuccess: ({ warnings }) => warn(warnings),
    onError,
    onSettled,
  });
}

export function useReply(documentId: string, viewer: Viewer) {
  const { queryClient, onError, onSettled } = useRollback(documentId);
  return useMutation({
    mutationFn: ({ threadId, body }: NewComment & { threadId: string }) =>
      apiClient.request(`/threads/${threadId}/comments`, {
        method: 'POST',
        body: { body },
        schema: commentWriteResultSchema,
      }),
    onMutate: ({ threadId, body, mentions }): Promise<Rollback> =>
      applyOptimistic(queryClient, documentId, (threads) =>
        threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                comments: [...thread.comments, optimisticComment(viewer, body, mentions)],
              }
            : thread,
        ),
      ),
    onSuccess: ({ warnings }) => warn(warnings),
    onError,
    onSettled,
  });
}

export function useSetResolved(documentId: string) {
  const { queryClient, onError, onSettled } = useRollback(documentId);
  return useMutation({
    mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) =>
      apiClient.request(`/threads/${threadId}/${resolved ? 'resolve' : 'reopen'}`, {
        method: 'POST',
        schema: threadSchema,
      }),
    onMutate: ({ threadId, resolved }): Promise<Rollback> =>
      applyOptimistic(queryClient, documentId, (threads) =>
        threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                resolved,
                resolvedAt: resolved ? new Date().toISOString() : null,
              }
            : thread,
        ),
      ),
    onError,
    onSettled,
  });
}
