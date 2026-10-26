// Reads the output of `next build` and fails when the published page stopped being a cheap, cacheable page:
//   - /p/[slug] has to be prerendered or ISR-capable (a `force-dynamic`, cookies() or headers() use removes it
//     from the prerender manifest), and
//   - none of the JavaScript the browser downloads for it may contain the editor, the CRDT or the query client.
// The editor route is scanned for the same markers first, so a renamed marker cannot make the check pass silently.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)), '.next');
const PUBLISHED = '/(public)/p/[slug]';
const EDITOR = '/(app)/w/[id]/d/[docId]';
// Strings that only exist in the code of the named library (they come from its error messages and class names).
const MARKERS = {
  ProseMirror: 'ProseMirror',
  Yjs: '__ $YJS$ __',
  'TanStack Query': 'No QueryClient set',
};
// The published page may ship React, Next and its own small components; this leaves room for growth, not for an editor.
const MAX_ROUTE_JS_GZIP_BYTES = 150 * 1024;

const failures = [];
const read = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'));

function chunksOf(manifest, route) {
  const files = [];
  for (const [page, chunks] of Object.entries(manifest.pages)) {
    if (page === `${route}/page` || page === `${route}/error` || page === `${route}/not-found`) {
      files.push(...chunks.filter((chunk) => chunk.endsWith('.js')));
    }
  }
  return [...new Set(files)];
}

function scan(files) {
  const found = new Set();
  let bytes = 0;
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, 'utf8');
    bytes += gzipSync(source).length;
    for (const [name, marker] of Object.entries(MARKERS)) {
      if (source.includes(marker)) found.add(name);
    }
  }
  return { found, bytes };
}

const manifest = read('app-build-manifest.json');

const editor = scan(chunksOf(manifest, EDITOR));
for (const name of Object.keys(MARKERS)) {
  if (!editor.found.has(name)) {
    failures.push(
      `marker for ${name} is not found in the editor route: update MARKERS in this script`,
    );
  }
}

const published = chunksOf(manifest, PUBLISHED);
if (published.length === 0) failures.push(`${PUBLISHED} is not in app-build-manifest.json`);
const page = scan(published);
for (const name of page.found) failures.push(`${PUBLISHED} downloads ${name}`);
if (page.bytes > MAX_ROUTE_JS_GZIP_BYTES) {
  failures.push(
    `${PUBLISHED} ships ${(page.bytes / 1024).toFixed(0)} kB of gzipped JavaScript (limit ${MAX_ROUTE_JS_GZIP_BYTES / 1024} kB)`,
  );
}

const prerender = read('prerender-manifest.json');
if (!prerender.dynamicRoutes['/p/[slug]']) {
  failures.push(
    '/p/[slug] is not in the prerender manifest: it renders dynamically on every request (no ISR)',
  );
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `✗ ${failure}`).join('\n'));
  process.exit(1);
}
console.log(
  `✓ /p/[slug] is ISR-capable and ships ${(page.bytes / 1024).toFixed(0)} kB of gzipped JavaScript, without ${Object.keys(MARKERS).join(', ')}`,
);
