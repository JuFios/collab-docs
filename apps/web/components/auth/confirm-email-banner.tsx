'use client';

import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';

/**
 * Shown until the account's address is confirmed: documents cannot be shared with it before then. A client island
 * only for the button that sends the link again.
 */
export function ConfirmEmailBanner({ email }: { email: string }) {
  const resend = useMutation({
    mutationFn: () => apiClient.request('/auth/verify-email/resend', { method: 'POST' }),
    onSuccess: () => toast.success(`We sent a new link to ${email}`),
  });
  return (
    <div
      role="status"
      className="border-b border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm">
        <p className="min-w-0 flex-1">
          Confirm your email address: open the link we sent to <strong>{email}</strong>. Until then,
          nobody can share a document with you.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={resend.isPending || resend.isSuccess}
          onClick={() => resend.mutate()}
        >
          {resend.isSuccess ? 'Link sent' : 'Send the link again'}
        </Button>
      </div>
    </div>
  );
}
