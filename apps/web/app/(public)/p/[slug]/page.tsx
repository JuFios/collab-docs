import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContentRenderer } from '@/components/content/content-renderer';
import { webOrigin } from '@/lib/env';
import { getPublishedDocument, publishedImageSrc } from '@/lib/public/published';

// Incremental static regeneration: the page is rendered on the first visit and then served from the cache until
// the api worker invalidates the `pub:<slug>` tag (or this window passes). Nothing below reads cookies or headers,
// which would turn the route into a dynamic one. The literal must equal PUBLISHED_PAGE_REVALIDATE_SECONDS.
export const revalidate = 3600;
export const generateStaticParams = () => [];

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  // the same call as the page's: Next shares the result between the two within one render
  const page = await getPublishedDocument(slug);
  if (!page) return { title: 'Page not found · Collab Docs', robots: { index: false } };
  const title = page.title || 'Untitled';
  const url = `${webOrigin()}/p/${encodeURIComponent(slug)}`;
  return {
    metadataBase: new URL(webOrigin()),
    title,
    description: page.description || undefined,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      type: 'article',
      siteName: 'Collab Docs',
      title,
      description: page.description || undefined,
      url,
      modifiedTime: page.updatedAt,
    },
    twitter: { card: 'summary', title, description: page.description || undefined },
  };
}

export default async function PublishedPage({ params }: PageProps) {
  const { slug } = await params;
  const page = await getPublishedDocument(slug);
  if (!page) notFound();
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <article>
        <header className="mb-8 border-b pb-6">
          <h1 className="text-4xl font-semibold tracking-tight">{page.title || 'Untitled'}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Updated{' '}
            <time dateTime={page.updatedAt}>
              {new Date(page.updatedAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                timeZone: 'UTC',
              })}
            </time>
          </p>
        </header>
        <ContentRenderer
          content={page.content}
          resolveImageSrc={publishedImageSrc(slug)}
          className="collab-editor"
        />
      </article>
      <footer className="mt-12 border-t pt-4 text-sm text-muted-foreground">
        Published with{' '}
        <Link href="/" className="underline underline-offset-2">
          Collab Docs
        </Link>
      </footer>
    </main>
  );
}
