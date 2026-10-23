import { jwtRoundTrip } from '@collab-docs/shared';

export default async function HomePage() {
  // Smoke check: the shared package and its ESM-only dependency load during `next build`.
  const smoke = await jwtRoundTrip('home');

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-semibold">Collab Docs</h1>
      <p className="mt-2 text-neutral-600" data-smoke={smoke}>
        Collaborative workspace with real-time document editing.
      </p>
    </main>
  );
}
