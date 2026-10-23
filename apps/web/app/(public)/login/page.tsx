import { sanitizeNextPath } from '@collab-docs/shared';
import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';

export const metadata: Metadata = { title: 'Sign in · Collab Docs' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <AuthCard title="Sign in" description="Welcome back to Collab Docs.">
      <LoginForm next={next ? sanitizeNextPath(next) : undefined} />
    </AuthCard>
  );
}
