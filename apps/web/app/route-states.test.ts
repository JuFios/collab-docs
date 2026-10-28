import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_DIR = import.meta.dirname;

/**
 * Pages that need no `loading.tsx` of their own, and why. A page is listed only while it really has no
 * data to wait for, so the audit fails when one of them starts fetching.
 */
const WITHOUT_LOADING: Record<string, string> = {
  '(public)/(interactive)/page.tsx': 'static landing page',
  '(public)/(interactive)/login/page.tsx': 'a form; only reads the `next` search parameter',
  '(public)/(interactive)/register/page.tsx': 'a form; only reads the `next` search parameter',
  '(public)/published/[slug]/page.tsx': 'ISR page served from the cache; nothing streams',
};

/** Exempt pages that do read data, because the cache answers instead of a request the user waits for. */
const CACHED = new Set(['(public)/published/[slug]/page.tsx']);

function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return pagesUnder(full);
    return entry.name === 'page.tsx' ? [path.relative(APP_DIR, full)] : [];
  });
}

/** The closest file called `name` in the page's folder or one above it: Next applies it to everything below. */
function nearest(page: string, name: string): string | null {
  let dir = path.dirname(page);
  for (;;) {
    const candidate = path.join(dir, name);
    if (existsSync(path.join(APP_DIR, candidate))) return candidate;
    if (dir === '.') return null;
    dir = path.dirname(dir);
  }
}

const pages = pagesUnder(APP_DIR).sort();

describe('every screen has its loading and error state', () => {
  it('finds the pages', () => {
    expect(pages.length).toBeGreaterThan(10);
  });

  it.each(pages)('%s has an error boundary', (page) => {
    expect(nearest(page, 'error.tsx'), 'no error.tsx in the page folder or above').not.toBeNull();
  });

  it.each(pages.filter((page) => !(page in WITHOUT_LOADING)))('%s has a loading state', (page) => {
    expect(
      nearest(page, 'loading.tsx'),
      'no loading.tsx in the page folder or above',
    ).not.toBeNull();
  });

  it('lists as exempt only pages that exist and do not fetch', () => {
    for (const page of CACHED) expect(pages).toContain(page);
    for (const page of Object.keys(WITHOUT_LOADING).filter((name) => !CACHED.has(name))) {
      expect(pages, `${page} is exempt but is not a page`).toContain(page);
      const source = readFileSync(path.join(APP_DIR, page), 'utf8');
      expect(source, `${page} fetches data, so it needs loading.tsx`).not.toMatch(
        /apiServer|getPublishedDocument|fetch\(/,
      );
    }
  });

  it('gives every page that can call notFound() a not-found page', () => {
    for (const page of pages) {
      const source = readFileSync(path.join(APP_DIR, page), 'utf8');
      if (!/\bnotFound\(\)/.test(source)) continue;
      expect(nearest(page, 'not-found.tsx'), `${page} calls notFound()`).not.toBeNull();
    }
  });
});
