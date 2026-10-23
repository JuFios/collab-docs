import { sanitizeNextPath } from '@collab-docs/shared';
import type { Metadata } from 'next';
import { AuthCard } from '@/components/auth/auth-card';
import { RegisterForm } from '@/components/auth/register-form';

export const metadata: Metadata = { title: 'Create account · Collab Docs' };

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <AuthCard title="Create your account" description="Start collaborating in minutes.">
      <RegisterForm next={next ? sanitizeNextPath(next) : undefined} />
    </AuthCard>
  );
}
