import { describe, expect, it } from 'vitest';
import {
  EDIT_TOKEN_PATTERN,
  EXPIRES_AT_PATTERN,
  PUBLIC_SLUG_PATTERN,
  REVALIDATE_MAX_TAGS,
  createPublicLinkInputSchema,
  publicPageTag,
  revalidateRequestSchema,
  updatePublicLinkInputSchema,
} from './public-links';

describe('revalidateRequestSchema', () => {
  it('accepts page tags', () => {
    expect(
      revalidateRequestSchema.safeParse({ tags: [publicPageTag('plan-3fa9c1')] }).success,
    ).toBe(true);
  });

  it.each([
    ['no tags', { tags: [] }],
    ['no body', {}],
    ['a tag of another kind', { tags: ['documents'] }],
    ['an empty slug', { tags: ['pub:'] }],
    ['an upper-case slug', { tags: ['pub:Plan'] }],
    ['a slug with a slash', { tags: ['pub:a/b'] }],
    ['a tag that is not text', { tags: [7] }],
    ['one bad tag among good ones', { tags: ['pub:ok', 'pub:Not Ok'] }],
    [
      'too many tags',
      { tags: Array.from({ length: REVALIDATE_MAX_TAGS + 1 }, (_, i) => `pub:a${i}`) },
    ],
    ['a very long slug', { tags: [`pub:${'a'.repeat(500)}`] }],
  ])('rejects %s', (_label, body) => {
    expect(revalidateRequestSchema.safeParse(body).success).toBe(false);
  });

  it('accepts the most tags allowed', () => {
    const tags = Array.from({ length: REVALIDATE_MAX_TAGS }, (_, i) => `pub:a${i}`);
    expect(revalidateRequestSchema.safeParse({ tags }).success).toBe(true);
  });
});

describe('patterns', () => {
  it.each(['a', 'plan-3fa9c1', 'a1-b2-c3'])('slug %s is valid', (slug) => {
    expect(PUBLIC_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it.each(['', '-a', 'a-', 'a--b', 'A', 'a b', 'a_b', 'a/b', 'é'])('slug %j is not', (slug) => {
    expect(PUBLIC_SLUG_PATTERN.test(slug)).toBe(false);
  });

  it('knows an edit token by its length and alphabet', () => {
    expect(EDIT_TOKEN_PATTERN.test('A'.repeat(43))).toBe(true);
    expect(EDIT_TOKEN_PATTERN.test('A'.repeat(42))).toBe(false);
    expect(EDIT_TOKEN_PATTERN.test(`${'A'.repeat(42)}+`)).toBe(false);
  });

  it.each(['2030-01-31T12:00:00Z', '2030-01-31T12:00:00.250Z', '2030-01-31T12:00:00+02:00'])(
    'expiry %s is valid',
    (value) => {
      expect(EXPIRES_AT_PATTERN.test(value)).toBe(true);
    },
  );

  it.each(['2030-01-31', '2030-01-31T12:00:00', '2030-01-31 12:00:00Z', 'tomorrow'])(
    'expiry %j is not',
    (value) => {
      expect(EXPIRES_AT_PATTERN.test(value)).toBe(false);
    },
  );
});

describe('input schemas', () => {
  it('lets an expiry be left out, null or set when creating', () => {
    for (const expiresAt of [undefined, null, '2030-01-31T12:00:00Z']) {
      expect(createPublicLinkInputSchema.safeParse({ mode: 'VIEW', expiresAt }).success).toBe(true);
    }
  });

  it('needs the expiry when updating, null meaning none', () => {
    expect(updatePublicLinkInputSchema.safeParse({ expiresAt: null }).success).toBe(true);
    expect(updatePublicLinkInputSchema.safeParse({}).success).toBe(false);
  });
});
