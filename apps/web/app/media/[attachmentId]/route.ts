import { PUBLIC_SLUG_MAX_LENGTH, PUBLIC_SLUG_PATTERN, UUID_PATTERN } from '@collab-docs/shared';
import { NextResponse } from 'next/server';
import { apiInternalUrl } from '@/lib/env';

export const runtime = 'nodejs';

/** The api signs the URL for 5 minutes; the browser may reuse the redirect for less than that. */
const REDIRECT_CACHE_SECONDS = 120;

/**
 * An image of a published page: `/media/<attachmentId>?slug=<slug>`. The api checks that the image belongs to the
 * document the slug publishes and answers with a short-lived signed URL, which is passed on as a redirect. No
 * cookies are read or sent, so the same answer holds for everyone.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const { attachmentId } = await params;
  const slug = new URL(request.url).searchParams.get('slug') ?? '';
  if (
    !UUID_PATTERN.test(attachmentId) ||
    slug.length > PUBLIC_SLUG_MAX_LENGTH ||
    !PUBLIC_SLUG_PATTERN.test(slug)
  ) {
    return new NextResponse(null, { status: 404 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      `${apiInternalUrl()}/api/public/media/${attachmentId}?slug=${encodeURIComponent(slug)}`,
      { redirect: 'manual', cache: 'no-store', headers: { accept: 'application/json' } },
    );
  } catch {
    return new NextResponse(null, { status: 502 });
  }
  const location = upstream.headers.get('location');
  if (upstream.status !== 302 || !location || !/^https?:\/\//i.test(location)) {
    return new NextResponse(null, { status: upstream.status === 404 ? 404 : 502 });
  }
  return new NextResponse(null, {
    status: 302,
    headers: {
      location,
      'cache-control': `public, max-age=${REDIRECT_CACHE_SECONDS}`,
      'referrer-policy': 'no-referrer',
    },
  });
}
