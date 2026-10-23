'use client';

import { loginInputSchema } from '@collab-docs/shared';
import Link from 'next/link';
import { type FormEvent, useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, FormField } from '@/components/ui/form';
import { loginAction } from '@/lib/auth/actions';
import { fieldErrorsFromZod } from '@/lib/auth/form-state';

/** Client component: `useActionState` for pending/error state and zod validation before the round trip. */
export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(loginAction, {});
  const [clientErrors, setClientErrors] = useState<Record<string, string[]>>({});
  const errors = { ...state.fieldErrors, ...clientErrors };

  function validate(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const parsed = loginInputSchema.safeParse({
      email: data.get('email'),
      password: data.get('password'),
    });
    if (parsed.success) {
      setClientErrors({});
      return;
    }
    event.preventDefault();
    setClientErrors(fieldErrorsFromZod(parsed.error));
  }

  return (
    <form action={formAction} onSubmit={validate} noValidate className="grid gap-4">
      <FormError message={state.formError} />
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <FormField
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        defaultValue={state.values?.email}
        errors={errors.email}
        required
      />
      <FormField
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        errors={errors.password}
        required
      />
      <Button type="submit" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        No account?{' '}
        <Link
          className="font-medium text-foreground underline underline-offset-4"
          href={next ? `/register?next=${encodeURIComponent(next)}` : '/register'}
        >
          Create one
        </Link>
      </p>
    </form>
  );
}
