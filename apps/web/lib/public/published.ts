import {
  PUBLIC_SLUG_MAX_LENGTH,
  PUBLIC_SLUG_PATTERN,
  type PublicDocument,
  publicDocumentSchema,
  publicPageTag,
} from '@collab-docs/shared';
import { apiPublic } from '@/lib/api/public';
import { isApiError } from '@/lib/api/errors';

/**
 * How long a published page is served from the cache when nothing invalidates it. The api worker normally drops the
 * `pub:<slug>` tag within seconds of a change; this is the fallback. A route segment's `revalidate` has to be a
 * literal, so the page repeats this value and a test keeps the two equal.
 */
export const PUBLISHED_PAGE_REVALIDATE_SECONDS = 3600;

export const isPublishedSlug = (slug: string): boolean =>
  slug.length <= PUBLIC_SLUG_MAX_LENGTH && PUBLIC_SLUG_PATTERN.test(slug);

/** The sanitised content of a published page, or null for a page that is not (or no longer) available. */
export async function getPublishedDocument(slug: string): Promise<PublicDocument | null> {
  if (!isPublishedSlug(slug)) return null;
  try {
    return await apiPublic(`/public/documents/${encodeURIComponent(slug)}`, {
      schema: publicDocumentSchema,
      next: { revalidate: PUBLISHED_PAGE_REVALIDATE_SECONDS, tags: [publicPageTag(slug)] },
    });
  } catch (error) {
    if (isApiError(error) && error.status === 404) return null;
    throw error;
  }
}

/** Images of a published page go through the `/media` handler, which asks the api for a signed URL. */
export const publishedImageSrc = (slug: string) => (attachmentId: string) =>
  `/media/${encodeURIComponent(attachmentId)}?slug=${encodeURIComponent(slug)}`;
