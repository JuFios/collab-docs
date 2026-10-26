import { createHash, timingSafeEqual } from 'node:crypto';
import { revalidateRequestSchema } from '@collab-docs/shared';
import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { revalidateSecret } from '@/lib/env';

export const runtime = 'nodejs';

/** Hashing first makes both sides the same length, which `timingSafeEqual` requires. */
function sameSecret(given: string | null, expected: string): boolean {
  if (!given) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Called by the api worker (not routed through the public proxy) when a published page has to be rebuilt:
 * `POST { tags: ['pub:<slug>'] }` with the shared secret. The next visit renders the page again from the api.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!sameSecret(request.headers.get('x-revalidate-secret'), revalidateSecret())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body: unknown = await request.json().catch(() => null);
  const parsed = revalidateRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  for (const tag of parsed.data.tags) revalidateTag(tag);
  return NextResponse.json({ revalidated: parsed.data.tags.length });
}
