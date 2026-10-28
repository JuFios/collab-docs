import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { DocumentGone } from '@/components/documents/document-gone';
import { DocumentShell } from '@/components/documents/document-shell';
import { ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/errors';
import { getCurrentUser, getDocument, getTrash } from '@/lib/workspaces/data';

/** The tab shows the document's title; the page below asks for the same document, which React shares. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ docId: string }>;
}): Promise<Metadata> {
  const { docId } = await params;
  const document = await getDocument(docId).catch(() => null);
  return { title: document ? document.title || 'Untitled' : 'Document' };
}

const threadParam = z.string().uuid();

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; docId: string }>;
  searchParams: Promise<{ thread?: string | string[] }>;
}) {
  const [{ id, docId }, query] = await Promise.all([params, searchParams]);
  // a link from a notification or an email: `?thread=<id>` opens that thread; anything else is ignored
  const thread = threadParam.safeParse(query.thread);
  let document;
  try {
    document = await getDocument(docId);
  } catch (error) {
    if (!isApiError(error)) throw error;
    if (error.status === 403) return <ForbiddenState />;
    if (error.status !== 404 && error.status !== 400) throw error;
    // deleted, never existed, or no access: the api answers 404 for all of them. A member can see their own
    // deleted documents in the trash, which is how "deleted" gets its own state.
    const trash = await getTrash(id).catch(() => null);
    if (trash?.some((item) => item.id === docId)) {
      return <DocumentGone workspaceId={id} documentId={docId} member />;
    }
    notFound();
  }
  // a document reached through another workspace's URL is not shown there
  if (document.workspaceId !== id) notFound();
  // already fetched by the layout; `cache` makes this the same request
  const user = await getCurrentUser();
  return (
    <DocumentShell
      key={document.id}
      workspaceId={id}
      initial={document}
      viewer={{ id: user.id, name: user.name }}
      initialThreadId={thread.success ? thread.data : null}
    />
  );
}
