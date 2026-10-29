import { LoadingState } from '@/components/states';

export default function VerifyEmailLoading() {
  return (
    <main className="mx-auto min-h-screen max-w-sm px-4 py-10">
      <LoadingState label="Confirming your email address…" />
    </main>
  );
}
