import { type ReactNode, useId } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { InputHTMLAttributes } from 'react';

interface FormFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  name: string;
  label: string;
  /** Messages for this field, from client-side or server-side validation. */
  errors?: string[];
  description?: ReactNode;
}

/** Label + input + messages wired with aria attributes; works with plain `<form action>` (no client JS needed). */
export function FormField({
  label,
  errors,
  description,
  className,
  ...inputProps
}: FormFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const descriptionId = `${id}-description`;
  const invalid = Boolean(errors?.length);
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={invalid}
        aria-describedby={
          [description ? descriptionId : null, invalid ? errorId : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
        {...inputProps}
      />
      {description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {invalid ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {errors?.join(' ')}
        </p>
      ) : null}
    </div>
  );
}

export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}
