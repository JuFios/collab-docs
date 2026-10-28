import { LoadingState } from '@/components/states';

export default function InviteLoading() {
  return (
    <main className="mx-auto min-h-screen max-w-sm px-4 py-10">
      <LoadingState label="Opening the invitation…" />
    </main>
  );
}
