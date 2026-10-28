import { accessAtLeast, roleAtLeast, type Access, type WorkspaceRole } from '@collab-docs/shared';
import {
  DOCUMENT_ACCESS,
  HAS_SESSION,
  UNKNOWN_ID,
  UNKNOWN_TOKEN,
  WORKSPACE_ROLE,
  type Fixture,
  type PersonaName,
  type Persona,
  type Resources,
  type Variant,
} from './fixture';

/** What a row sends: values for the `{placeholders}` of the route, plus the body and the query. */
export interface Call {
  params?: Record<string, string>;
  body?: object;
  query?: Record<string, string>;
  /** An event stream: only the status line is read, then the connection is dropped. */
  stream?: boolean;
}

/**
 * Who may do what, in the vocabulary of the permission model (spec §4). Every policy is turned into one
 * expected status per persona, so a row says "an editor can do this" and not "a viewer gets 403".
 *
 * - no session (anon and the two link personas) → 401, unless the route is public;
 * - no access at all (not a member, restricted document without a share) → 404, so existence is not disclosed;
 * - some access, but less than needed → 403.
 */
type Policy =
  | { kind: 'open'; status: number }
  | { kind: 'authenticated'; ok: number }
  | { kind: 'workspace'; min: WorkspaceRole; ok: number }
  | { kind: 'document'; min: Exclude<Access, 'NONE'>; ok: number }
  /** `/public`: the link personas see their link, everybody else a link that does not exist. */
  | { kind: 'link'; live: number; expired: number; unknown: number }
  | { kind: 'explicit'; expect: (variant: Variant) => Record<PersonaName, number> };

interface Row {
  policy: Policy;
  /** `open`-variant only: the row aims at no document of the two variants. */
  once?: boolean;
  call: (r: Resources, p: Persona, f: Fixture) => Promise<Call> | Call;
}

export function expectedStatus(policy: Policy, persona: PersonaName, variant: Variant): number {
  switch (policy.kind) {
    case 'open':
      return policy.status;
    case 'link':
      return persona === 'guestLink'
        ? policy.live
        : persona === 'expiredLink'
          ? policy.expired
          : policy.unknown;
    case 'explicit':
      return policy.expect(variant)[persona];
  }
  if (!HAS_SESSION(persona)) return 401;
  switch (policy.kind) {
    case 'authenticated':
      return policy.ok;
    case 'workspace': {
      const role = WORKSPACE_ROLE[persona];
      if (!role) return 404;
      return roleAtLeast(role, policy.min) ? policy.ok : 403;
    }
    case 'document': {
      const access = DOCUMENT_ACCESS[variant][persona] ?? 'NONE';
      if (access === 'NONE') return 404;
      return accessAtLeast(access, policy.min) ? policy.ok : 403;
    }
  }
}

const open = (status: number): Policy => ({ kind: 'open', status });
const authenticated = (ok: number): Policy => ({ kind: 'authenticated', ok });
const workspace = (min: WorkspaceRole, ok: number): Policy => ({ kind: 'workspace', min, ok });
const document = (min: Exclude<Access, 'NONE'>, ok: number): Policy => ({
  kind: 'document',
  min,
  ok,
});

/** Everybody without a session gets 401; the rest of the personas are given. */
const withUnauthenticated = (
  rest: Record<Exclude<PersonaName, 'anon' | 'guestLink' | 'expiredLink'>, number>,
): Record<PersonaName, number> => ({
  anon: 401,
  guestLink: 401,
  expiredLink: 401,
  ...rest,
});

const docRow = (min: Exclude<Access, 'NONE'>, ok: number, call: Row['call']): Row => ({
  policy: document(min, ok),
  call,
});
const wsRow = (min: WorkspaceRole, ok: number, call: Row['call']): Row => ({
  policy: workspace(min, ok),
  call,
});
const authRow = (ok: number, call: Row['call']): Row => ({ policy: authenticated(ok), call });
const openRow = (status: number, call: Row['call'] = () => ({})): Row => ({
  policy: open(status),
  once: true,
  call,
});

const ws = (r: Resources): Call => ({ params: { workspaceId: r.workspaceId } });
const doc = (r: Resources): Call => ({ params: { id: r.document } });

/** A link persona's slug / token; everybody else aims at a link that does not exist. */
const slugOf = (p: Persona, f: Fixture) =>
  p.name === 'guestLink' ? f.live.slug : p.name === 'expiredLink' ? f.expired.slug : 'no-such-page';
const editTokenOf = (p: Persona, f: Fixture) =>
  p.name === 'guestLink'
    ? f.live.editToken
    : p.name === 'expiredLink'
      ? f.expired.editToken
      : UNKNOWN_TOKEN;

/**
 * The matrix: one entry per route of the OpenAPI document. A route without an entry (or an entry without a route)
 * fails the suite, so a new endpoint cannot ship without a decision about who may call it.
 */
export const IDOR_TABLE: Record<string, Row> = {
  // --- platform ---
  'GET /health': openRow(200),
  'GET /ready': openRow(200),

  // --- auth: nothing here depends on who asks; the request is made to fail the same way for everyone ---
  'POST /api/auth/register': openRow(400, () => ({ body: {} })),
  'POST /api/auth/login': openRow(400, () => ({ body: {} })),
  'POST /api/auth/refresh': openRow(401),
  'GET /api/auth/refresh': openRow(302),
  'POST /api/auth/logout': openRow(204),
  'GET /api/auth/me': authRow(200, () => ({})),

  // --- workspaces ---
  'POST /api/workspaces': authRow(201, () => ({ body: { name: 'Another' } })),
  'GET /api/workspaces': authRow(200, () => ({})),
  'GET /api/workspaces/{workspaceId}': wsRow('VIEWER', 200, ws),
  'PATCH /api/workspaces/{workspaceId}': wsRow('ADMIN', 200, (r) => ({
    ...ws(r),
    body: { name: 'Renamed' },
  })),
  'GET /api/workspaces/{workspaceId}/usage': wsRow('VIEWER', 200, ws),
  'GET /api/workspaces/{workspaceId}/members': wsRow('VIEWER', 200, ws),
  'PATCH /api/workspaces/{workspaceId}/members/{userId}': wsRow('ADMIN', 200, async (r) => ({
    ...ws(r),
    params: { workspaceId: r.workspaceId, userId: await r.member() },
    body: { role: 'VIEWER' },
  })),
  'DELETE /api/workspaces/{workspaceId}/members/{userId}': wsRow('ADMIN', 204, async (r) => ({
    params: { workspaceId: r.workspaceId, userId: await r.member() },
  })),
  'POST /api/workspaces/{workspaceId}/invites': wsRow('ADMIN', 201, (r) => ({
    ...ws(r),
    body: {
      email: `invitee-${Date.now()}-${Math.random().toString(36).slice(2)}@security-test.example`,
      role: 'EDITOR',
    },
  })),
  'GET /api/workspaces/{workspaceId}/invites': wsRow('ADMIN', 200, ws),
  'DELETE /api/workspaces/{workspaceId}/invites/{inviteId}': wsRow('ADMIN', 204, async (r) => ({
    params: { workspaceId: r.workspaceId, inviteId: await r.invite() },
  })),
  'GET /api/invites/{token}': openRow(400, () => ({ params: { token: UNKNOWN_TOKEN } })),
  'POST /api/invites/{token}/accept': {
    policy: {
      kind: 'explicit',
      expect: () =>
        withUnauthenticated({
          outsider: 400,
          viewer: 400,
          editor: 400,
          admin: 400,
          owner: 400,
          guest: 400,
        }),
    },
    once: true,
    call: () => ({ params: { token: UNKNOWN_TOKEN } }),
  },
  'GET /api/events/stream': wsRow('VIEWER', 200, (r) => ({
    query: { workspaceId: r.workspaceId },
    stream: true,
  })),

  // --- documents ---
  'POST /api/workspaces/{workspaceId}/documents': wsRow('EDITOR', 201, (r) => ({
    ...ws(r),
    body: { title: 'New' },
  })),
  'GET /api/workspaces/{workspaceId}/documents/tree': wsRow('VIEWER', 200, ws),
  'GET /api/workspaces/{workspaceId}/documents/recent': wsRow('VIEWER', 200, ws),
  'GET /api/workspaces/{workspaceId}/trash': wsRow('VIEWER', 200, ws),
  'GET /api/documents/{id}': docRow('VIEW', 200, doc),
  'PATCH /api/documents/{id}': docRow('EDIT', 200, (r) => ({
    ...doc(r),
    body: { title: 'Renamed' },
  })),
  'DELETE /api/documents/{id}': docRow('EDIT', 204, async (r) => ({
    params: { id: await r.fresh() },
  })),
  'POST /api/documents/{id}/restore': {
    policy: {
      kind: 'explicit',
      // only the admins bring a document back; whoever could open it before gets 403 (the trash lists it for them),
      // everybody else the same 404 as for a document that never existed
      expect: (variant) =>
        withUnauthenticated({
          outsider: 404,
          viewer: variant === 'open' ? 403 : 404,
          editor: variant === 'open' ? 403 : 404,
          admin: 200,
          owner: 200,
          guest: 403,
        }),
    },
    call: async (r) => ({ params: { id: await r.deleted() } }),
  },
  'POST /api/documents/{id}/move': docRow('EDIT', 200, async (r) => ({
    params: { id: await r.fresh() },
    body: { parentId: null },
  })),
  'GET /api/me/shared-documents': authRow(200, () => ({})),

  // --- sharing ---
  'GET /api/documents/{id}/shares': docRow('MANAGE', 200, doc),
  'POST /api/documents/{id}/shares': docRow('MANAGE', 201, async (r, _p, f) => ({
    params: { id: await r.fresh() },
    body: { email: f.spare.email, role: 'VIEWER' },
  })),
  'PATCH /api/documents/{id}/shares/{userId}': docRow('MANAGE', 200, async (r) => {
    const shared = await r.sharedWithSpare();
    return { params: { id: shared.documentId, userId: shared.userId }, body: { role: 'EDITOR' } };
  }),
  'DELETE /api/documents/{id}/shares/{userId}': docRow('MANAGE', 204, async (r) => {
    const shared = await r.sharedWithSpare();
    return { params: { id: shared.documentId, userId: shared.userId } };
  }),

  // --- collaboration ---
  'POST /api/documents/{id}/collab-ticket': docRow('VIEW', 200, doc),

  // --- versions ---
  'GET /api/documents/{id}/versions': docRow('VIEW', 200, doc),
  'POST /api/documents/{id}/versions': docRow('EDIT', 201, async (r) => ({
    params: { id: await r.fresh() },
    body: { label: 'Milestone' },
  })),
  'GET /api/documents/{id}/versions/{versionId}': docRow('VIEW', 200, async (r) => {
    const v = await r.version();
    return { params: { id: v.documentId, versionId: v.versionId } };
  }),
  'POST /api/documents/{id}/versions/{versionId}/restore': docRow('EDIT', 200, async (r) => {
    const v = await r.version();
    return { params: { id: v.documentId, versionId: v.versionId } };
  }),

  // --- attachments ---
  'POST /api/documents/{id}/attachments/presign': docRow('EDIT', 201, (r) => ({
    ...doc(r),
    body: { filename: 'a.png', mime: 'image/png', size: 100 },
  })),
  // 422: the caller may complete the upload, but nothing was uploaded to the bucket for this row
  'POST /api/attachments/{id}/complete': docRow('EDIT', 422, async (r) => ({
    params: { id: (await r.attachment('PENDING')).attachmentId },
  })),
  'GET /api/attachments/{id}/url': docRow('VIEW', 200, async (r) => ({
    params: { id: (await r.attachment()).attachmentId },
  })),

  // --- publishing ---
  'GET /api/documents/{id}/public-links': docRow('MANAGE', 200, doc),
  'POST /api/documents/{id}/public-links': docRow('MANAGE', 201, async (r) => ({
    params: { id: await r.fresh() },
    body: { mode: 'VIEW' },
  })),
  'PATCH /api/documents/{id}/public-links/{linkId}': docRow('MANAGE', 200, async (r) => {
    const l = await r.linked();
    return { params: { id: l.documentId, linkId: l.linkId }, body: { expiresAt: null } };
  }),
  'DELETE /api/documents/{id}/public-links/{linkId}': docRow('MANAGE', 204, async (r) => {
    const l = await r.linked();
    return { params: { id: l.documentId, linkId: l.linkId } };
  }),
  'GET /api/public/documents/{slug}': {
    policy: { kind: 'link', live: 200, expired: 404, unknown: 404 },
    once: true,
    call: (_r, p, f) => ({ params: { slug: slugOf(p, f) } }),
  },
  'GET /api/public/media/{attachmentId}': {
    policy: { kind: 'link', live: 404, expired: 404, unknown: 404 },
    once: true,
    call: (_r, p, f) => ({ params: { attachmentId: UNKNOWN_ID }, query: { slug: slugOf(p, f) } }),
  },
  'GET /api/public/links/{token}': {
    policy: { kind: 'link', live: 200, expired: 410, unknown: 404 },
    once: true,
    call: (_r, p, f) => ({ params: { token: editTokenOf(p, f) } }),
  },
  'POST /api/public/links/{token}/ticket': {
    policy: { kind: 'link', live: 200, expired: 410, unknown: 404 },
    once: true,
    call: (_r, p, f) => ({ params: { token: editTokenOf(p, f) } }),
  },

  // --- search ---
  'GET /api/workspaces/{workspaceId}/search': wsRow('VIEWER', 200, (r) => ({
    ...ws(r),
    query: { q: 'doc' },
  })),

  // --- comments ---
  'GET /api/documents/{id}/threads': docRow('VIEW', 200, doc),
  'POST /api/documents/{id}/threads': docRow('COMMENT', 201, async (r) => ({
    params: { id: await r.fresh() },
    body: { blockId: 'block-1', body: 'A remark' },
  })),
  'GET /api/documents/{id}/mentionable': docRow('COMMENT', 200, (r) => ({
    ...doc(r),
    query: { q: 'a' },
  })),
  'POST /api/threads/{threadId}/comments': docRow('COMMENT', 201, async (r) => ({
    params: { threadId: (await r.thread()).threadId },
    body: { body: 'A reply' },
  })),
  'POST /api/threads/{threadId}/resolve': docRow('COMMENT', 200, async (r) => ({
    params: { threadId: (await r.thread()).threadId },
  })),
  'POST /api/threads/{threadId}/reopen': docRow('COMMENT', 200, async (r) => ({
    params: { threadId: (await r.thread()).threadId },
  })),
  // only the author edits a comment; a reader who is not the author gets 403, somebody who cannot see it 404
  'PATCH /api/comments/{commentId}': {
    policy: {
      kind: 'explicit',
      expect: (variant) =>
        withUnauthenticated({
          outsider: 404,
          viewer: variant === 'open' ? 403 : 404,
          editor: variant === 'open' ? 403 : 404,
          admin: 403,
          owner: 200,
          guest: 403,
        }),
    },
    call: async (r) => ({
      params: { commentId: (await r.thread()).commentId },
      body: { body: 'Edited' },
    }),
  },
  'DELETE /api/comments/{commentId}': {
    policy: {
      kind: 'explicit',
      expect: (variant) =>
        withUnauthenticated({
          outsider: 404,
          viewer: variant === 'open' ? 403 : 404,
          editor: variant === 'open' ? 403 : 404,
          admin: 204,
          owner: 204,
          guest: 403,
        }),
    },
    call: async (r) => ({ params: { commentId: (await r.thread()).commentId } }),
  },

  // --- notifications: a user's own notifications, nothing to aim at ---
  'GET /api/notifications': authRow(200, () => ({})),
  'GET /api/notifications/unread-count': authRow(200, () => ({})),
  'POST /api/notifications/read': authRow(200, () => ({ body: { all: true } })),

  // --- billing ---
  'GET /api/billing/plans': authRow(200, () => ({})),
  'GET /api/workspaces/{workspaceId}/billing': wsRow('ADMIN', 200, ws),
  'POST /api/workspaces/{workspaceId}/billing/checkout': wsRow('ADMIN', 201, (r) => ({
    ...ws(r),
    body: { plan: 'PRO' },
  })),
  'POST /api/workspaces/{workspaceId}/billing/cancel': wsRow('ADMIN', 202, ws),
  // the provider authenticates with a signature, not a session
  'POST /api/billing/webhooks/mock': openRow(401, () => ({ body: {} })),
  'GET /api/mock-provider/checkout-sessions/{id}': openRow(404, () => ({
    params: { id: UNKNOWN_ID },
  })),
  'POST /api/mock-provider/checkout-sessions/{id}/complete': openRow(404, () => ({
    params: { id: UNKNOWN_ID },
  })),
  'POST /api/mock-provider/checkout-sessions/{id}/fail': openRow(404, () => ({
    params: { id: UNKNOWN_ID },
  })),
  'POST /api/mock-provider/events/{id}/redeliver': openRow(404, () => ({
    params: { id: UNKNOWN_ID },
  })),
};
