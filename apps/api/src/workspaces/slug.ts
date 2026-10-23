import { randomBytes } from 'node:crypto';

/** `Acme Inc.` -> `acme-inc-3fa9c1`. The random suffix keeps slugs unique without a lookup loop. */
export function generateSlug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || 'workspace'}-${randomBytes(3).toString('hex')}`;
}
