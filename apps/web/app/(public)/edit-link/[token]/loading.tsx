import { LoadingState } from '@/components/states';

export default function EditLinkLoading() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-10">
      <LoadingState label="Opening the shared document…" />
    </main>
  );
}
