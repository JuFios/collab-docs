import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocumentGone } from '@/components/documents/document-gone';
import { DocumentShell } from '@/components/documents/document-shell';
import { ForbiddenState } from '@/components/states';
import { isApiError } from '@/lib/api/errors';
import { getDocument, getTrash } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Document · Collab Docs' };

export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string; docId: string }>;
}) {
  const { id, docId } = await params;
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
  return <DocumentShell key={document.id} workspaceId={id} initial={document} />;
}
