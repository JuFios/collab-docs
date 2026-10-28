import Link from 'next/link';
import { Button } from '@/components/ui/button';

// no cookies()/headers(): the landing page stays statically rendered
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-8">
      <h1 className="text-4xl font-semibold tracking-tight">Collab Docs</h1>
      <p className="text-lg text-muted-foreground">
        Collaborative workspace with real-time document editing.
      </p>
      <div className="flex gap-3">
        <Button asChild>
          <Link href="/register">Get started</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
