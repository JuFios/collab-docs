import type { Metadata } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Collab Docs',
  description: 'Collaborative workspace with real-time document editing.',
};

// Static on purpose: no cookies()/headers() here, so public routes can be prerendered or ISR'd. The client providers
// live in the layouts of the route groups that need them, so the published page does not download them.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="bg-background font-sans text-foreground antialiased">{children}</body>
    </html>
  );
}
