'use client';

import { PASSWORD_MIN_LENGTH, registerInputSchema } from '@collab-docs/shared';
import Link from 'next/link';
import { type FormEvent, useActionState, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, FormField } from '@/components/ui/form';
import { registerAction } from '@/lib/auth/actions';
import { fieldErrorsFromZod } from '@/lib/auth/form-state';

/** Client component: same pattern as the login form (pending state, client-side zod pass). */
export function RegisterForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(registerAction, {});
  const [clientErrors, setClientErrors] = useState<Record<string, string[]>>({});
  const errors = { ...state.fieldErrors, ...clientErrors };

  function validate(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    const parsed = registerInputSchema.safeParse({
      name: data.get('name'),
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
        name="name"
        label="Name"
        autoComplete="name"
        defaultValue={state.values?.name}
        errors={errors.name}
        required
      />
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
        autoComplete="new-password"
        description={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        errors={errors.password}
        required
      />
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        Already registered?{' '}
        <Link
          className="font-medium text-foreground underline underline-offset-4"
          href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'}
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
