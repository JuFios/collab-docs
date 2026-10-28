'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { apiClient } from '@/lib/api/client';

/**
 * For public pages that look different to a signed-in visitor. The browser drops the access cookie when it
 * expires, and the refresh cookie is sent only to `/api/auth`, so the server render of such a page cannot tell
 * an anonymous visitor from one whose session just needs renewing. This asks the api, and re-renders the page
 * when the session comes back. An anonymous visitor gets a 401 and sees no change.
 */
export function RenewSession() {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    apiClient
      .refresh()
      .then(() => {
        if (active) router.refresh();
      })
      .catch(() => {
        // no session to renew
      });
    return () => {
      active = false;
    };
  }, [router]);
  return null;
}
