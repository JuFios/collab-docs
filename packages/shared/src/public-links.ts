import { z } from 'zod';

export const PUBLIC_LINK_MODES = ['VIEW', 'EDIT'] as const;
export type PublicLinkMode = (typeof PUBLIC_LINK_MODES)[number];

/** `active` is the only state in which a link grants anything. */
export const PUBLIC_LINK_STATUSES = ['active', 'expired', 'revoked'] as const;
export type PublicLinkStatus = (typeof PUBLIC_LINK_STATUSES)[number];

/** A link cannot be set to expire further ahead than this (also keeps the delayed expiry job in range). */
export const PUBLIC_LINK_MAX_TTL_DAYS = 5 * 365;

export const PUBLIC_SLUG_MAX_LENGTH = 80;
/** Lower-case words joined by single dashes: `quarterly-plan-3fa9c1d2`. */
export const PUBLIC_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** EDIT tokens are 256 random bits in base64url. */
export const EDIT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Cache tag of a published page: the slug is all the page fetch knows before it has the document. */
export const PUBLIC_PAGE_TAG_PREFIX = 'pub:';
export const publicPageTag = (slug: string): string => `${PUBLIC_PAGE_TAG_PREFIX}${slug}`;

/** Body of `POST /internal/revalidate` on the web app (sent by the api worker). */
export const REVALIDATE_MAX_TAGS = 20;
export const revalidateRequestSchema = z.object({
  tags: z
    .array(z.string().max(PUBLIC_SLUG_MAX_LENGTH + PUBLIC_PAGE_TAG_PREFIX.length))
    .min(1)
    .max(REVALIDATE_MAX_TAGS)
    .refine(
      (tags) =>
        tags.every(
          (tag) =>
            tag.startsWith(PUBLIC_PAGE_TAG_PREFIX) &&
            PUBLIC_SLUG_PATTERN.test(tag.slice(PUBLIC_PAGE_TAG_PREFIX.length)),
        ),
      'every tag must be pub:<slug>',
    ),
});
export type RevalidateRequest = z.infer<typeof revalidateRequestSchema>;

/** `2030-01-31T12:00:00Z` or with an offset / fraction. The calendar is checked where the date is parsed. */
export const EXPIRES_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const expiresAtSchema = z.string().regex(EXPIRES_AT_PATTERN);

export const createPublicLinkInputSchema = z.object({
  mode: z.enum(PUBLIC_LINK_MODES),
  /** Omitted or null: the link never expires. Must lie in the future. */
  expiresAt: expiresAtSchema.nullish(),
});
export type CreatePublicLinkInput = z.infer<typeof createPublicLinkInputSchema>;

export const updatePublicLinkInputSchema = z.object({
  /** null removes the expiry. */
  expiresAt: expiresAtSchema.nullable(),
});
export type UpdatePublicLinkInput = z.infer<typeof updatePublicLinkInputSchema>;

export const publicLinkSchema = z.object({
  id: z.string(),
  mode: z.enum(PUBLIC_LINK_MODES),
  /** VIEW links: the stable page address. */
  slug: z.string().nullable(),
  status: z.enum(PUBLIC_LINK_STATUSES),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PublicLink = z.infer<typeof publicLinkSchema>;

export const publicLinkListSchema = z.array(publicLinkSchema);

export const createdPublicLinkSchema = publicLinkSchema.extend({
  /** EDIT links: the secret, shown once (the database keeps only its hash). */
  token: z.string().nullable(),
  /** VIEW links: false when the collab service could not write its buffer first, so the page may miss the last few seconds. */
  flushed: z.boolean().nullable(),
});
export type CreatedPublicLink = z.infer<typeof createdPublicLinkSchema>;

/** What `GET /public/documents/:slug` returns: nothing that identifies a user or a workspace. */
export const publicDocumentSchema = z.object({
  title: z.string(),
  description: z.string(),
  content: z.object({ type: z.literal('doc'), content: z.array(z.unknown()) }),
  updatedAt: z.string(),
});
export type PublicDocument = z.infer<typeof publicDocumentSchema>;

/** What `GET /public/links/:token` returns for a live EDIT link. */
export const editLinkStateSchema = z.object({
  mode: z.literal('EDIT'),
  documentId: z.string(),
  title: z.string(),
  expiresAt: z.string().nullable(),
});
export type EditLinkState = z.infer<typeof editLinkStateSchema>;
