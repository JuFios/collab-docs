import { z } from 'zod';

export interface AuthFormState {
  /** Field name -> messages. */
  fieldErrors?: Record<string, string[]>;
  formError?: string;
  /** Echoed back so a failed submit does not clear the inputs (never the password). */
  values?: { name?: string; email?: string };
}

export function fieldErrorsFromZod(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? '');
    (out[field] ??= []).push(issue.message);
  }
  return out;
}

export function textField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export function rateLimitMessage(retryAfterSeconds: number | undefined): string {
  return retryAfterSeconds && retryAfterSeconds > 0
    ? `Too many attempts. Try again in ${retryAfterSeconds} seconds.`
    : 'Too many attempts. Please wait a moment and try again.';
}
