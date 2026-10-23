import type { Metadata } from 'next';
import Link from 'next/link';
import { EmptyState } from '@/components/states';
import { getSharedDocuments } from '@/lib/workspaces/data';

export const metadata: Metadata = { title: 'Shared with me · Collab Docs' };

export default async function SharedPage() {
  const documents = await getSharedDocuments();
  return (
    <section aria-labelledby="shared-heading" className="mx-auto grid max-w-3xl gap-4">
      <h1 id="shared-heading" className="text-2xl font-semibold">
        Shared with me
      </h1>
      {documents.length === 0 ? (
        <EmptyState
          title="Nothing has been shared with you"
          description="Documents other people share with you directly show up here, in any workspace."
        />
      ) : (
        <ul className="divide-y rounded-lg border bg-card">
          {documents.map((document) => (
            <li key={document.id}>
              <Link
                href={`/w/${document.workspaceId}/d/${document.id}`}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-accent/50"
              >
                <span className="truncate">
                  <span aria-hidden>{document.icon ?? '📄'}</span> {document.title || 'Untitled'}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {document.role === 'EDITOR' ? 'Can edit' : 'Can view'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
