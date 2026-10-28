import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';

// TanStack Query and the toaster are for the pages with forms; the published page (`/published/[slug]`) ships neither
export default function SiteLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
