export const DEFAULT_NEXT_PATH = '/workspaces';

/**
 * Returns `value` when it is a same-origin relative path that is safe to redirect to, else `fallback`.
 * Rejects absolute and protocol-relative URLs, backslashes (browsers treat them as `/`) and control characters.
 */
export function sanitizeNextPath(
  value: string | null | undefined,
  fallback: string = DEFAULT_NEXT_PATH,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const parsed = new URL(value, 'http://sanitize.invalid');
    if (parsed.origin !== 'http://sanitize.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
