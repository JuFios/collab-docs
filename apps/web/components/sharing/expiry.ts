/** `<input type="datetime-local">` value (local time, no zone) to the ISO instant the api expects; empty means never. */
export function toExpiresAt(local: string): string | null {
  if (!local) return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The reverse, for showing a stored expiry in a `datetime-local` input. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatExpiry(iso: string | null): string {
  return iso ? `Expires ${new Date(iso).toLocaleString()}` : 'Never expires';
}
