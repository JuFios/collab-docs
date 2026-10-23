import '../test/documents-env';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { PrismaClient } from '@collab-docs/db';
import {
  PERM_EVENT_CHANNELS,
  REALTIME_CHANNEL,
  type WorkspaceRole,
} from '@collab-docs/shared';
import { QUEUE_NAMES, QueueService } from '@collab-docs/shared/nest';
import { createTestApp } from '../test/test-app';

const PASSWORD = 'correct-horse-battery';
const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe('documents', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let redis: Redis;
  let subscriber: Redis;
  const published: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  let counter = 0;
  let ipCounter = 0;

  const http$ = () => request(app.getHttpServer());
  const nextIp = () => `10.3.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  async function register(label = 'user'): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@docs-test.example`;
    const response = await http$()
      .post('/api/auth/register')
      .set('X-Forwarded-For', nextIp())
      .send({ email, password: PASSWORD, name: label })
      .expect(201);
    return { id: response.body.user.id, email, token: response.body.accessToken };
  }

  const as = (user: TestUser) => ({
    get: (path: string) => http$().get(`/api${path}`).set('Authorization', `Bearer ${user.token}`),
    post: (path: string) =>
      http$().post(`/api${path}`).set('Authorization', `Bearer ${user.token}`),
    patch: (path: string) =>
      http$().patch(`/api${path}`).set('Authorization', `Bearer ${user.token}`),
    delete: (path: string) =>
      http$().delete(`/api${path}`).set('Authorization', `Bearer ${user.token}`),
  });

  async function addMember(workspaceId: string, user: TestUser, role: WorkspaceRole) {
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
  }

  /** Workspace on the PRO plan (so ACL tests are not bounded by the FREE limits) with one user per role. */
  async function setupTeam(plan: 'FREE' | 'PRO' = 'PRO') {
    const [owner, admin, editor, editor2, viewer, outsider] = await Promise.all(
      ['owner', 'admin', 'editor', 'editor2', 'viewer', 'outsider'].map(register),
    );
    const created = await as(owner!).post('/workspaces').send({ name: 'Docs' }).expect(201);
    const workspaceId = created.body.id as string;
    if (plan === 'PRO') {
      await prisma.subscription.update({ where: { workspaceId }, data: { plan } });
    }
    await addMember(workspaceId, admin!, 'ADMIN');
    await addMember(workspaceId, editor!, 'EDITOR');
    await addMember(workspaceId, editor2!, 'EDITOR');
    await addMember(workspaceId, viewer!, 'VIEWER');
    return {
      workspaceId,
      owner: owner!,
      admin: admin!,
      editor: editor!,
      editor2: editor2!,
      viewer: viewer!,
      outsider: outsider!,
    };
  }

  async function createDoc(
    user: TestUser,
    workspaceId: string,
    body: { title?: string; parentId?: string } = {},
  ): Promise<{ id: string; parentId: string | null; position: string; [key: string]: unknown }> {
    const response = await as(user)
      .post(`/workspaces/${workspaceId}/documents`)
      .send({ title: 'Doc', ...body })
      .expect(201);
    return response.body;
  }

  const treeOf = async (user: TestUser, workspaceId: string) =>
    (await as(user).get(`/workspaces/${workspaceId}/documents/tree`).expect(200)).body as Array<{
      id: string;
      parentId: string | null;
      title: string;
      myAccess: string;
    }>;

  async function share(owner: TestUser, documentId: string, user: TestUser, role: string) {
    await as(owner)
      .post(`/documents/${documentId}/shares`)
      .send({ email: user.email, role })
      .expect(201);
  }

  const messagesOn = (channel: string) => published.filter((m) => m.channel === channel);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();
    redis = new Redis(process.env.REDIS_URL as string);
    subscriber = new Redis(process.env.REDIS_URL as string);
    await subscriber.subscribe(...Object.values(PERM_EVENT_CHANNELS), REALTIME_CHANNEL);
    subscriber.on('message', (channel, raw) =>
      published.push({ channel, payload: JSON.parse(raw) as Record<string, unknown> }),
    );
    app = await createTestApp();
    prisma = app.get(PrismaClient, { strict: false });
  });

  afterAll(async () => {
    redis.disconnect();
    subscriber.disconnect();
    await app.close();
  });

  describe('crud', () => {
    it('creates, reads, renames and reports the access level', async () => {
      const team = await setupTeam();
      const doc = await createDoc(team.editor, team.workspaceId, { title: '  Roadmap ' });
      expect(doc).toMatchObject({
        title: 'Roadmap',
        parentId: null,
        visibility: 'WORKSPACE',
        revision: 0,
        myAccess: 'EDIT',
        createdBy: team.editor.id,
      });

      const asViewer = await as(team.viewer).get(`/documents/${doc.id}`).expect(200);
      expect(asViewer.body.myAccess).toBe('VIEW');
      const asAdmin = await as(team.admin).get(`/documents/${doc.id}`).expect(200);
      expect(asAdmin.body.myAccess).toBe('MANAGE');

      const renamed = await as(team.editor)
        .patch(`/documents/${doc.id}`)
        .send({ title: 'Roadmap 2027', icon: '🗺️' })
        .expect(200);
      expect(renamed.body).toMatchObject({ title: 'Roadmap 2027', icon: '🗺️', revision: 1 });
      const cleared = await as(team.editor)
        .patch(`/documents/${doc.id}`)
        .send({ icon: null })
        .expect(200);
      expect(cleared.body).toMatchObject({ icon: null, revision: 2 });
    });

    it('validates input', async () => {
      const team = await setupTeam();
      await as(team.editor)
        .post(`/workspaces/${team.workspaceId}/documents`)
        .send({ title: 'x'.repeat(201) })
        .expect(400);
      await as(team.editor)
        .post(`/workspaces/${team.workspaceId}/documents`)
        .send({ title: 'ok', parentId: 'not-a-uuid' })
        .expect(400);
      const doc = await createDoc(team.editor, team.workspaceId);
      await as(team.editor).patch(`/documents/${doc.id}`).send({}).expect(400);
      await as(team.editor)
        .patch(`/documents/${doc.id}`)
        .send({ visibility: 'PUBLIC' })
        .expect(400);
    });

    it('appends siblings in creation order', async () => {
      const team = await setupTeam();
      const a = await createDoc(team.editor, team.workspaceId, { title: 'a' });
      const b = await createDoc(team.editor, team.workspaceId, { title: 'b' });
      const c = await createDoc(team.editor, team.workspaceId, { title: 'c', parentId: a.id });
      expect(a.position < b.position).toBe(true);
      expect(c.parentId).toBe(a.id);
      const tree = await treeOf(team.owner, team.workspaceId);
      // flat list sorted by position, then id: c is the first child of a, so it shares a's key
      expect(tree.map((n) => n.title)).toEqual(['a', 'c', 'b']);
    });

    it('copies visibility and shares of the parent into a new child', async () => {
      const team = await setupTeam();
      const guest = await register('guest');
      const parent = await createDoc(team.owner, team.workspaceId);
      await as(team.owner)
        .patch(`/documents/${parent.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      await share(team.owner, parent.id, team.editor, 'EDITOR');
      await share(team.owner, parent.id, guest, 'VIEWER');

      const child = await createDoc(team.editor, team.workspaceId, { parentId: parent.id });
      expect(child.visibility).toBe('RESTRICTED');
      const shares = await prisma.documentShare.findMany({ where: { documentId: child.id } });
      expect(shares.map((s) => [s.userId, s.role]).sort()).toEqual(
        [
          [team.editor.id, 'EDITOR'],
          [guest.id, 'VIEWER'],
        ].sort(),
      );
      // a snapshot, not live inheritance: later changes to the parent do not reach the child
      await as(team.owner).delete(`/documents/${parent.id}/shares/${guest.id}`).expect(204);
      await as(guest).get(`/documents/${child.id}`).expect(200);
    });
  });

  describe('permissions matrix', () => {
    type Who = 'owner' | 'admin' | 'editor' | 'editor2' | 'viewer' | 'outsider';
    const WHO: Who[] = ['owner', 'admin', 'editor', 'editor2', 'viewer', 'outsider'];

    // document authored by `editor`; `editor2` is a second editor who did not write it
    const cases: Array<{
      name: string;
      call: (user: TestUser, id: string, ws: string, other: TestUser) => request.Test;
      expected: Record<Who, number>;
    }> = [
      {
        name: 'GET /documents/:id',
        call: (u, id) => as(u).get(`/documents/${id}`),
        expected: { owner: 200, admin: 200, editor: 200, editor2: 200, viewer: 200, outsider: 404 },
      },
      {
        name: 'PATCH title',
        call: (u, id) => as(u).patch(`/documents/${id}`).send({ title: 'new' }),
        expected: { owner: 200, admin: 200, editor: 200, editor2: 200, viewer: 403, outsider: 404 },
      },
      {
        name: 'PATCH visibility (MANAGE or EDIT author)',
        call: (u, id) => as(u).patch(`/documents/${id}`).send({ visibility: 'RESTRICTED' }),
        expected: { owner: 200, admin: 200, editor: 200, editor2: 403, viewer: 403, outsider: 404 },
      },
      {
        name: 'POST move to root',
        call: (u, id) => as(u).post(`/documents/${id}/move`).send({ parentId: null }),
        expected: { owner: 200, admin: 200, editor: 200, editor2: 200, viewer: 403, outsider: 404 },
      },
      {
        name: 'GET shares',
        call: (u, id) => as(u).get(`/documents/${id}/shares`),
        expected: { owner: 200, admin: 200, editor: 200, editor2: 403, viewer: 403, outsider: 404 },
      },
      {
        name: 'POST shares',
        call: (u, id, _ws, other) =>
          as(u).post(`/documents/${id}/shares`).send({ email: other.email, role: 'VIEWER' }),
        expected: { owner: 201, admin: 201, editor: 201, editor2: 403, viewer: 403, outsider: 404 },
      },
      {
        name: 'DELETE',
        call: (u, id) => as(u).delete(`/documents/${id}`),
        expected: { owner: 204, admin: 204, editor: 204, editor2: 204, viewer: 403, outsider: 404 },
      },
      {
        name: 'POST create child',
        call: (u, id, ws) =>
          as(u).post(`/workspaces/${ws}/documents`).send({ title: 'c', parentId: id }),
        expected: { owner: 201, admin: 201, editor: 201, editor2: 201, viewer: 403, outsider: 404 },
      },
    ];

    it.each(cases)('$name', async ({ call, expected }) => {
      const team = await setupTeam();
      const other = await register('share-target');
      for (const who of WHO) {
        const doc = await createDoc(team.editor, team.workspaceId);
        const response = await call(team[who], doc.id, team.workspaceId, other);
        expect({ who, status: response.status }).toEqual({ who, status: expected[who] });
      }
    });

    it('unknown and malformed ids look exactly like missing access', async () => {
      const team = await setupTeam();
      for (const id of [UNKNOWN_ID, 'not-a-uuid']) {
        for (const path of [`/documents/${id}`, `/documents/${id}/shares`]) {
          await as(team.owner).get(path).expect(404);
        }
        await as(team.owner).patch(`/documents/${id}`).send({ title: 'x' }).expect(404);
        await as(team.owner).delete(`/documents/${id}`).expect(404);
        await as(team.owner).post(`/documents/${id}/move`).send({ parentId: null }).expect(404);
      }
      await as(team.owner).post(`/documents/${UNKNOWN_ID}/restore`).expect(404);
    });

    it('requires authentication', async () => {
      await http$().get(`/api/documents/${UNKNOWN_ID}`).expect(401);
      await http$().get(`/api/events/stream?workspaceId=${UNKNOWN_ID}`).expect(401);
    });

    it('workspace routes: viewers read, outsiders get 404', async () => {
      const team = await setupTeam();
      for (const path of ['documents/tree', 'trash']) {
        await as(team.viewer).get(`/workspaces/${team.workspaceId}/${path}`).expect(200);
        await as(team.outsider).get(`/workspaces/${team.workspaceId}/${path}`).expect(404);
      }
      await as(team.outsider)
        .post(`/workspaces/${team.workspaceId}/documents`)
        .send({ title: 'x' })
        .expect(404);
    });

    it('create needs EDIT on the parent, and a restricted parent is invisible without a share', async () => {
      const team = await setupTeam();
      const parent = await createDoc(team.owner, team.workspaceId);
      await as(team.owner)
        .patch(`/documents/${parent.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);

      await as(team.editor)
        .post(`/workspaces/${team.workspaceId}/documents`)
        .send({ title: 'x', parentId: parent.id })
        .expect(404);
      await share(team.owner, parent.id, team.editor, 'VIEWER');
      await as(team.editor)
        .post(`/workspaces/${team.workspaceId}/documents`)
        .send({ title: 'x', parentId: parent.id })
        .expect(403);
      await as(team.owner)
        .patch(`/documents/${parent.id}/shares/${team.editor.id}`)
        .send({ role: 'EDITOR' })
        .expect(200);
      await as(team.editor)
        .post(`/workspaces/${team.workspaceId}/documents`)
        .send({ title: 'x', parentId: parent.id })
        .expect(201);
    });

    it('rejects a parent from another workspace as not found', async () => {
      const a = await setupTeam();
      const b = await setupTeam();
      const foreign = await createDoc(b.owner, b.workspaceId);
      await as(a.owner)
        .post(`/workspaces/${a.workspaceId}/documents`)
        .send({ title: 'x', parentId: foreign.id })
        .expect(404);
    });
  });

  describe('plan limits', () => {
    const fill = async (workspaceId: string, owner: TestUser, count: number) => {
      await prisma.document.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          workspaceId,
          title: `filler ${i}`,
          position: `a${String(i).padStart(3, '0')}`,
          createdBy: owner.id,
        })),
      });
    };

    it('refuses the 21st document on FREE with PLAN_LIMIT_EXCEEDED', async () => {
      const team = await setupTeam('FREE');
      await fill(team.workspaceId, team.owner, 20);
      const response = await as(team.owner)
        .post(`/workspaces/${team.workspaceId}/documents`)
        .send({ title: 'one too many' })
        .expect(403);
      expect(response.body).toMatchObject({
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { kind: 'documents', limit: 20, current: 20, plan: 'FREE' },
      });
    });

    it('serialises concurrent creates: exactly the free slots succeed', async () => {
      const team = await setupTeam('FREE');
      await fill(team.workspaceId, team.owner, 18);
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          as(team.owner)
            .post(`/workspaces/${team.workspaceId}/documents`)
            .send({ title: `race ${i}` }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      expect(results.filter((r) => r.status === 403)).toHaveLength(4);
      expect(await prisma.document.count({ where: { workspaceId: team.workspaceId } })).toBe(20);
    });

    it('does not count deleted documents against the limit', async () => {
      const team = await setupTeam('FREE');
      await fill(team.workspaceId, team.owner, 19);
      const last = await createDoc(team.owner, team.workspaceId);
      await as(team.owner).delete(`/documents/${last.id}`).expect(204);
      await createDoc(team.owner, team.workspaceId);
    });
  });

  describe('soft delete, trash and restore', () => {
    it('deletes the whole subtree and restores exactly that deletion', async () => {
      const team = await setupTeam();
      const root = await createDoc(team.editor, team.workspaceId, { title: 'root' });
      const child = await createDoc(team.editor, team.workspaceId, {
        title: 'child',
        parentId: root.id,
      });
      const grand = await createDoc(team.editor, team.workspaceId, {
        title: 'grand',
        parentId: child.id,
      });
      const keep = await createDoc(team.editor, team.workspaceId, { title: 'keep' });

      // child goes first (its own deletion), then the root takes the rest of the subtree
      await as(team.editor).delete(`/documents/${child.id}`).expect(204);
      await as(team.editor).delete(`/documents/${root.id}`).expect(204);

      const rows = await prisma.document.findMany({
        where: { id: { in: [root.id, child.id, grand.id, keep.id] } },
        select: { id: true, deletedAt: true, deletedRootId: true, revision: true },
      });
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[root.id]).toMatchObject({ deletedRootId: root.id });
      expect(byId[child.id]).toMatchObject({ deletedRootId: child.id });
      expect(byId[grand.id]).toMatchObject({ deletedRootId: child.id });
      expect(byId[keep.id]?.deletedAt).toBeNull();
      expect(byId[grand.id]?.revision).toBe(1n);

      await as(team.editor).get(`/documents/${grand.id}`).expect(404);
      expect((await treeOf(team.owner, team.workspaceId)).map((n) => n.id)).not.toContain(root.id);

      const trash = (await as(team.editor).get(`/workspaces/${team.workspaceId}/trash`).expect(200))
        .body as Array<{ id: string; documentCount: number; canRestore: boolean }>;
      expect(trash.map((t) => [t.id, t.documentCount]).sort()).toEqual(
        [
          [root.id, 1],
          [child.id, 2],
        ].sort(),
      );

      // restoring the root brings back only the root: child's subtree was a separate deletion
      await as(team.editor).post(`/documents/${root.id}/restore`).expect(200);
      expect(
        (await prisma.document.findUnique({ where: { id: child.id } }))?.deletedAt,
      ).not.toBeNull();
      // child's parent is alive again, so child returns under it, together with grand
      const restored = await as(team.editor).post(`/documents/${child.id}/restore`).expect(200);
      expect(restored.body).toMatchObject({ id: child.id, parentId: root.id, revision: 2 });
      await as(team.editor).get(`/documents/${grand.id}`).expect(200);
    });

    it('returns to the root when the parent is still deleted, and refuses a non-root restore', async () => {
      const team = await setupTeam();
      const parent = await createDoc(team.editor, team.workspaceId);
      const child = await createDoc(team.editor, team.workspaceId, { parentId: parent.id });
      const grand = await createDoc(team.editor, team.workspaceId, { parentId: child.id });
      await as(team.editor).delete(`/documents/${child.id}`).expect(204);
      await as(team.editor).delete(`/documents/${parent.id}`).expect(204);

      // grand was deleted with child, not with parent
      await as(team.editor).post(`/documents/${grand.id}/restore`).expect(409);
      const restored = await as(team.editor).post(`/documents/${child.id}/restore`).expect(200);
      expect(restored.body.parentId).toBeNull();
      await as(team.editor).get(`/documents/${grand.id}`).expect(200);
      await as(team.editor).post(`/documents/${child.id}/restore`).expect(409);
    });

    it('limits who may restore: owner/admin always, an editor only for their own documents', async () => {
      const team = await setupTeam();
      const doc = await createDoc(team.editor, team.workspaceId);
      await as(team.editor).delete(`/documents/${doc.id}`).expect(204);
      await as(team.viewer).post(`/documents/${doc.id}/restore`).expect(403);
      await as(team.editor2).post(`/documents/${doc.id}/restore`).expect(403);
      await as(team.outsider).post(`/documents/${doc.id}/restore`).expect(404);
      const trash = (
        await as(team.editor2).get(`/workspaces/${team.workspaceId}/trash`).expect(200)
      ).body as Array<{ id: string; canRestore: boolean }>;
      expect(trash.find((t) => t.id === doc.id)?.canRestore).toBe(false);
      await as(team.editor).post(`/documents/${doc.id}/restore`).expect(200);

      const second = await createDoc(team.editor, team.workspaceId);
      await as(team.editor).delete(`/documents/${second.id}`).expect(204);
      await as(team.admin).post(`/documents/${second.id}/restore`).expect(200);
    });

    it('hides the trash entries of restricted documents from members without access', async () => {
      const team = await setupTeam();
      const secret = await createDoc(team.owner, team.workspaceId);
      await as(team.owner)
        .patch(`/documents/${secret.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      await as(team.owner).delete(`/documents/${secret.id}`).expect(204);
      const ids = async (user: TestUser) =>
        (
          (await as(user).get(`/workspaces/${team.workspaceId}/trash`).expect(200)).body as Array<{
            id: string;
          }>
        ).map((t) => t.id);
      expect(await ids(team.admin)).toContain(secret.id);
      expect(await ids(team.editor)).not.toContain(secret.id);
      await as(team.editor).post(`/documents/${secret.id}/restore`).expect(404);
    });

    it('refuses to restore beyond the plan limit', async () => {
      const team = await setupTeam('FREE');
      const parent = await createDoc(team.owner, team.workspaceId);
      await createDoc(team.owner, team.workspaceId, { parentId: parent.id });
      await createDoc(team.owner, team.workspaceId, { parentId: parent.id });
      await as(team.owner).delete(`/documents/${parent.id}`).expect(204);
      await prisma.document.createMany({
        data: Array.from({ length: 19 }, (_, i) => ({
          workspaceId: team.workspaceId,
          title: `filler ${i}`,
          position: `a${String(i).padStart(3, '0')}`,
          createdBy: team.owner.id,
        })),
      });
      const response = await as(team.owner).post(`/documents/${parent.id}/restore`).expect(403);
      expect(response.body).toMatchObject({ code: 'PLAN_LIMIT_EXCEEDED' });
      expect(
        (await prisma.document.findUnique({ where: { id: parent.id } }))?.deletedAt,
      ).not.toBeNull();
    });

    it('deletes descendants the caller cannot see (permissions are not inherited)', async () => {
      const team = await setupTeam();
      const parent = await createDoc(team.editor, team.workspaceId);
      const hidden = await createDoc(team.owner, team.workspaceId, { parentId: parent.id });
      await as(team.owner)
        .patch(`/documents/${hidden.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      await as(team.editor).get(`/documents/${hidden.id}`).expect(404);

      await as(team.editor).delete(`/documents/${parent.id}`).expect(204);
      expect(
        (await prisma.document.findUnique({ where: { id: hidden.id } }))?.deletedAt,
      ).not.toBeNull();
    });
  });

  describe('tree', () => {
    it('filters by permission and lifts nodes under a hidden parent to the root', async () => {
      const team = await setupTeam();
      const open = await createDoc(team.owner, team.workspaceId, { title: 'open' });
      const secret = await createDoc(team.owner, team.workspaceId, { title: 'secret' });
      const underSecret = await createDoc(team.owner, team.workspaceId, {
        title: 'under',
        parentId: secret.id,
      });
      await as(team.owner)
        .patch(`/documents/${secret.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      // the child was created before the parent went restricted, so it stays workspace-visible

      const asEditor = await treeOf(team.editor, team.workspaceId);
      expect(asEditor.map((n) => [n.title, n.parentId])).toEqual([
        ['open', null],
        ['under', null],
      ]);
      expect(JSON.stringify(asEditor)).not.toContain(secret.id);

      const asOwner = await treeOf(team.owner, team.workspaceId);
      expect(asOwner.find((n) => n.id === underSecret.id)?.parentId).toBe(secret.id);
      expect(asOwner.find((n) => n.id === open.id)?.myAccess).toBe('MANAGE');

      // a share opens the restricted node for one editor only
      await share(team.owner, secret.id, team.editor2, 'VIEWER');
      const asEditor2 = await treeOf(team.editor2, team.workspaceId);
      expect(asEditor2.find((n) => n.id === secret.id)).toMatchObject({ myAccess: 'VIEW' });
      expect(asEditor2.find((n) => n.id === underSecret.id)?.parentId).toBe(secret.id);
      expect((await treeOf(team.editor, team.workspaceId)).map((n) => n.id)).not.toContain(
        secret.id,
      );
    });

    it('hides the parent id of a single document when the parent is inaccessible', async () => {
      const team = await setupTeam();
      const parent = await createDoc(team.owner, team.workspaceId);
      const child = await createDoc(team.owner, team.workspaceId, { parentId: parent.id });
      await as(team.owner)
        .patch(`/documents/${parent.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      const seen = await as(team.editor).get(`/documents/${child.id}`).expect(200);
      expect(seen.body.parentId).toBeNull();
      expect((await as(team.owner).get(`/documents/${child.id}`)).body.parentId).toBe(parent.id);
    });

    it('is cached per version, invalidated by every mutation, and counts hits and misses', async () => {
      const team = await setupTeam();
      const versionKey = `tree:ver:${team.workspaceId}`;
      const metric = async (result: string) => {
        const text = (await http$().get('/metrics')).text;
        const line = text
          .split('\n')
          .find((l) => l.startsWith(`tree_cache_lookups_total{result="${result}"`));
        return Number(line?.split(' ')[1] ?? 0);
      };
      const hitsBefore = await metric('hit');
      const missesBefore = await metric('miss');

      await createDoc(team.owner, team.workspaceId, { title: 'one' });
      const version = Number(await redis.get(versionKey));
      expect(version).toBeGreaterThan(0);

      await treeOf(team.owner, team.workspaceId); // miss, fills `tree:{ws}:{version}`
      expect(await redis.exists(`tree:${team.workspaceId}:${version}`)).toBe(1);
      await treeOf(team.owner, team.workspaceId); // hit
      await treeOf(team.viewer, team.workspaceId); // hit, permissions applied after the cache
      expect(await metric('miss')).toBe(missesBefore + 1);
      expect(await metric('hit')).toBe(hitsBefore + 2);

      const doc = await createDoc(team.owner, team.workspaceId, { title: 'two' });
      expect(Number(await redis.get(versionKey))).toBe(version + 1);
      expect((await treeOf(team.owner, team.workspaceId)).map((n) => n.title)).toEqual([
        'one',
        'two',
      ]);

      // rename, visibility, move, share, delete and restore each bump the version once
      const other = await register('cache-share');
      const sequence: Array<() => request.Test> = [
        () => as(team.owner).patch(`/documents/${doc.id}`).send({ title: 'renamed' }),
        () => as(team.owner).patch(`/documents/${doc.id}`).send({ visibility: 'RESTRICTED' }),
        () => as(team.owner).post(`/documents/${doc.id}/move`).send({ parentId: null }),
        () =>
          as(team.owner)
            .post(`/documents/${doc.id}/shares`)
            .send({ email: other.email, role: 'VIEWER' }),
        () => as(team.owner).delete(`/documents/${doc.id}`),
        () => as(team.owner).post(`/documents/${doc.id}/restore`),
      ];
      for (const call of sequence) {
        const before = Number(await redis.get(versionKey));
        await call().expect((r) => expect(r.status).toBeLessThan(300));
        expect(Number(await redis.get(versionKey))).toBe(before + 1);
      }
      const titles = (await treeOf(team.owner, team.workspaceId)).map((n) => n.title);
      expect(titles).toEqual(['one', 'renamed']);
    });
  });

  describe('move', () => {
    it('reorders with before/after and moves between parents', async () => {
      const team = await setupTeam();
      for (const title of ['a', 'b', 'c', 'd']) {
        await createDoc(team.editor, team.workspaceId, { title });
      }
      const docs = await treeOf(team.editor, team.workspaceId);
      const id = (title: string) => docs.find((n) => n.title === title)!.id;
      const order = async () => (await treeOf(team.editor, team.workspaceId)).map((n) => n.title);
      expect(await order()).toEqual(['a', 'b', 'c', 'd']);

      await as(team.editor)
        .post(`/documents/${id('d')}/move`)
        .send({ parentId: null, beforeId: id('a') })
        .expect(200);
      expect(await order()).toEqual(['d', 'a', 'b', 'c']);
      await as(team.editor)
        .post(`/documents/${id('d')}/move`)
        .send({ parentId: null, afterId: id('b') })
        .expect(200);
      expect(await order()).toEqual(['a', 'b', 'd', 'c']);
      await as(team.editor)
        .post(`/documents/${id('a')}/move`)
        .send({ parentId: null, afterId: id('b'), beforeId: id('d') })
        .expect(200);
      expect(await order()).toEqual(['b', 'a', 'd', 'c']);
      await as(team.editor)
        .post(`/documents/${id('b')}/move`)
        .send({ parentId: null })
        .expect(200);
      expect(await order()).toEqual(['a', 'd', 'c', 'b']);

      const moved = await as(team.editor)
        .post(`/documents/${id('c')}/move`)
        .send({ parentId: id('a') })
        .expect(200);
      expect(moved.body).toMatchObject({ id: id('c'), parentId: id('a') });
      expect(
        (await treeOf(team.editor, team.workspaceId)).find((n) => n.title === 'c')?.parentId,
      ).toBe(id('a'));
      // a neighbour must be a child of the new parent
      await as(team.editor)
        .post(`/documents/${id('d')}/move`)
        .send({ parentId: id('a'), afterId: id('b') })
        .expect(400);
      await as(team.editor)
        .post(`/documents/${id('d')}/move`)
        .send({ parentId: null, afterId: id('d') })
        .expect(400);
    });

    it('rejects cycles', async () => {
      const team = await setupTeam();
      const a = await createDoc(team.owner, team.workspaceId);
      const b = await createDoc(team.owner, team.workspaceId, { parentId: a.id });
      const c = await createDoc(team.owner, team.workspaceId, { parentId: b.id });
      await as(team.owner).post(`/documents/${a.id}/move`).send({ parentId: a.id }).expect(409);
      await as(team.owner).post(`/documents/${a.id}/move`).send({ parentId: c.id }).expect(409);
      await as(team.owner).post(`/documents/${c.id}/move`).send({ parentId: a.id }).expect(200);
    });

    it('never produces a cycle when two moves race', async () => {
      const team = await setupTeam();
      for (let round = 0; round < 5; round++) {
        const a = await createDoc(team.owner, team.workspaceId);
        const b = await createDoc(team.owner, team.workspaceId);
        const [first, second] = await Promise.all([
          as(team.owner).post(`/documents/${a.id}/move`).send({ parentId: b.id }),
          as(team.owner).post(`/documents/${b.id}/move`).send({ parentId: a.id }),
        ]);
        expect([first.status, second.status].sort()).toEqual([200, 409]);
      }
    });

    it('needs EDIT on both the document and the new parent, and the same workspace', async () => {
      const team = await setupTeam();
      const doc = await createDoc(team.editor, team.workspaceId);
      const lockedParent = await createDoc(team.owner, team.workspaceId);
      await as(team.owner)
        .patch(`/documents/${lockedParent.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);

      await as(team.editor)
        .post(`/documents/${doc.id}/move`)
        .send({ parentId: lockedParent.id })
        .expect(404);
      await share(team.owner, lockedParent.id, team.editor, 'VIEWER');
      await as(team.editor)
        .post(`/documents/${doc.id}/move`)
        .send({ parentId: lockedParent.id })
        .expect(403);
      await as(team.viewer).post(`/documents/${doc.id}/move`).send({ parentId: null }).expect(403);

      const foreign = await setupTeam();
      const foreignDoc = await createDoc(foreign.owner, foreign.workspaceId);
      await as(team.owner)
        .post(`/documents/${doc.id}/move`)
        .send({ parentId: foreignDoc.id })
        .expect(404);
      // a user in both workspaces still cannot move across them
      await addMember(foreign.workspaceId, team.owner, 'EDITOR');
      await as(team.owner)
        .post(`/documents/${doc.id}/move`)
        .send({ parentId: foreignDoc.id })
        .expect(400);
    });
  });

  describe('shares', () => {
    it('shares with registered users only, gives guests a narrow view, and revokes', async () => {
      const team = await setupTeam();
      const guest = await register('guest');
      const doc = await createDoc(team.owner, team.workspaceId, { title: 'shared' });
      const sibling = await createDoc(team.owner, team.workspaceId, { title: 'private sibling' });

      await as(team.owner)
        .post(`/documents/${doc.id}/shares`)
        .send({ email: 'nobody@docs-test.example', role: 'VIEWER' })
        .expect(404);
      await as(team.owner)
        .post(`/documents/${doc.id}/shares`)
        .send({ email: team.owner.email, role: 'VIEWER' })
        .expect(400);
      await as(team.owner)
        .post(`/documents/${doc.id}/shares`)
        .send({ email: guest.email, role: 'OWNER' })
        .expect(400);

      // email is matched case-insensitively
      const created = await as(team.owner)
        .post(`/documents/${doc.id}/shares`)
        .send({ email: guest.email.toUpperCase(), role: 'VIEWER' })
        .expect(201);
      expect(created.body).toMatchObject({ userId: guest.id, role: 'VIEWER' });

      await as(guest).get(`/documents/${doc.id}`).expect(200);
      await as(guest).patch(`/documents/${doc.id}`).send({ title: 'x' }).expect(403);
      await as(guest).get(`/documents/${sibling.id}`).expect(404);
      await as(guest).get(`/workspaces/${team.workspaceId}/documents/tree`).expect(404);
      await as(guest).get(`/workspaces/${team.workspaceId}`).expect(404);
      const shared = await as(guest).get('/me/shared-documents').expect(200);
      expect(shared.body).toEqual([
        { id: doc.id, workspaceId: team.workspaceId, title: 'shared', icon: null, role: 'VIEWER' },
      ]);

      await as(team.owner)
        .patch(`/documents/${doc.id}/shares/${guest.id}`)
        .send({ role: 'EDITOR' })
        .expect(200);
      await as(guest).patch(`/documents/${doc.id}`).send({ title: 'edited by guest' }).expect(200);
      const listed = await as(team.owner).get(`/documents/${doc.id}/shares`).expect(200);
      expect(listed.body).toEqual([
        { userId: guest.id, email: guest.email, name: 'guest', role: 'EDITOR' },
      ]);

      await as(team.owner).delete(`/documents/${doc.id}/shares/${guest.id}`).expect(204);
      await as(team.owner).delete(`/documents/${doc.id}/shares/${guest.id}`).expect(404);
      await as(guest).get(`/documents/${doc.id}`).expect(404);
      expect((await as(guest).get('/me/shared-documents').expect(200)).body).toEqual([]);
    });

    it('a share overrides the workspace role, upwards and downwards', async () => {
      const team = await setupTeam();
      const doc = await createDoc(team.owner, team.workspaceId);
      await share(team.owner, doc.id, team.viewer, 'EDITOR');
      await share(team.owner, doc.id, team.editor, 'VIEWER');
      await as(team.viewer).patch(`/documents/${doc.id}`).send({ title: 'up' }).expect(200);
      await as(team.editor).patch(`/documents/${doc.id}`).send({ title: 'down' }).expect(403);
      expect((await as(team.editor).get(`/documents/${doc.id}`)).body.myAccess).toBe('VIEW');
    });

    it('hides deleted documents from the shared list', async () => {
      const team = await setupTeam();
      const guest = await register('guest');
      const doc = await createDoc(team.owner, team.workspaceId);
      await share(team.owner, doc.id, guest, 'VIEWER');
      await as(team.owner).delete(`/documents/${doc.id}`).expect(204);
      expect((await as(guest).get('/me/shared-documents').expect(200)).body).toEqual([]);
      await as(guest).get(`/documents/${doc.id}`).expect(404);
    });
  });

  describe('events', () => {
    it('publishes perm.changed for visibility and shares, and doc.deleted / doc.restored, after commit', async () => {
      const team = await setupTeam();
      const doc = await createDoc(team.owner, team.workspaceId);
      const child = await createDoc(team.owner, team.workspaceId, { parentId: doc.id });
      published.length = 0;

      await as(team.owner)
        .patch(`/documents/${doc.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      await share(team.owner, doc.id, team.editor, 'EDITOR');
      await as(team.owner).delete(`/documents/${doc.id}`).expect(204);
      await as(team.owner).post(`/documents/${doc.id}/restore`).expect(200);
      await settle();

      expect(messagesOn(PERM_EVENT_CHANNELS.permChanged).map((m) => m.payload)).toEqual([
        expect.objectContaining({
          documentId: doc.id,
          workspaceId: team.workspaceId,
          reason: 'visibility_changed',
        }),
        expect.objectContaining({
          documentId: doc.id,
          userId: team.editor.id,
          reason: 'share_changed',
        }),
      ]);
      const deleted = messagesOn(PERM_EVENT_CHANNELS.docDeleted);
      expect(deleted).toHaveLength(1);
      expect((deleted[0]!.payload.documentIds as string[]).sort()).toEqual(
        [doc.id, child.id].sort(),
      );
      expect(messagesOn(PERM_EVENT_CHANNELS.docRestored)).toHaveLength(1);
    });

    it('publishes nothing when the transaction rolls back', async () => {
      const team = await setupTeam('FREE');
      await prisma.document.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          workspaceId: team.workspaceId,
          title: `filler ${i}`,
          position: `a${String(i).padStart(3, '0')}`,
          createdBy: team.owner.id,
        })),
      });
      const versionKey = `tree:ver:${team.workspaceId}`;
      const before = await redis.get(versionKey);
      published.length = 0;

      await as(team.owner)
        .post(`/workspaces/${team.workspaceId}/documents`)
        .send({ title: 'x' })
        .expect(403);
      await settle();
      expect(await redis.get(versionKey)).toBe(before);
      expect(published.filter((m) => JSON.stringify(m.payload).includes(team.workspaceId))).toEqual(
        [],
      );
    });

    it('enqueues one debounced document.changed job per window for title, icon, delete and restore', async () => {
      const team = await setupTeam();
      const doc = await createDoc(team.owner, team.workspaceId);
      const queues = app.get(QueueService, { strict: false });
      const jobsFor = async (name: string) =>
        (await queues.getQueue(name).getJobs(['delayed', 'waiting'])).filter(
          (j) => j.data.documentId === doc.id,
        );

      expect(await jobsFor(QUEUE_NAMES.searchSync)).toHaveLength(0);
      await as(team.owner).patch(`/documents/${doc.id}`).send({ title: 'one' }).expect(200);
      await as(team.owner).patch(`/documents/${doc.id}`).send({ title: 'two' }).expect(200);
      await as(team.owner).patch(`/documents/${doc.id}`).send({ icon: '📄' }).expect(200);

      for (const [name, delay] of [
        [QUEUE_NAMES.searchSync, 5000],
        [QUEUE_NAMES.publicRevalidate, 3000],
      ] as const) {
        const jobs = await jobsFor(name);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.opts.delay).toBe(delay);
        expect(jobs[0]!.data).toMatchObject({ documentId: doc.id, reason: 'title' });
      }

      // visibility and moves do not change derived data
      const quiet = await createDoc(team.owner, team.workspaceId);
      await as(team.owner)
        .patch(`/documents/${quiet.id}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      await as(team.owner)
        .post(`/documents/${quiet.id}/move`)
        .send({ parentId: doc.id })
        .expect(200);
      const quietJobs = (
        await queues.getQueue(QUEUE_NAMES.searchSync).getJobs(['delayed', 'waiting'])
      ).filter((j) => j.data.documentId === quiet.id);
      expect(quietJobs).toHaveLength(0);

      await as(team.owner).delete(`/documents/${quiet.id}`).expect(204);
      await as(team.owner).post(`/documents/${quiet.id}/restore`).expect(200);
      const afterLifecycle = (
        await queues.getQueue(QUEUE_NAMES.searchSync).getJobs(['delayed', 'waiting'])
      ).filter((j) => j.data.documentId === quiet.id);
      expect(afterLifecycle).toHaveLength(1);
      expect(afterLifecycle[0]!.data.reason).toBe('delete');
    });
  });

  describe('SSE', () => {
    interface Stream {
      statusCode: number;
      headers: http.IncomingHttpHeaders;
      chunks: string[];
      close: () => void;
    }

    function openStream(user: TestUser, workspaceId: string): Promise<Stream> {
      const { port } = app.getHttpServer().address() as AddressInfo;
      return new Promise((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/api/events/stream?workspaceId=${workspaceId}`,
          { headers: { Authorization: `Bearer ${user.token}` } },
          (res) => {
            const stream: Stream = {
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              chunks: [],
              close: () => req.destroy(),
            };
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => stream.chunks.push(chunk));
            res.on('error', () => undefined);
            resolve(stream);
          },
        );
        req.on('error', reject);
      });
    }

    const eventsOf = (stream: Stream) =>
      stream.chunks
        .join('')
        .split('\n\n')
        .filter((block) => block.startsWith('event: '))
        .map((block) => ({
          event: block.split('\n')[0]!.slice(7),
          data: JSON.parse(block.split('\n')[1]!.slice(6)) as Record<string, unknown>,
        }));

    beforeAll(async () => {
      await app.listen(0);
    });

    it('delivers tree.changed to members of that workspace only', async () => {
      const team = await setupTeam();
      const other = await setupTeam();
      const member = await openStream(team.viewer, team.workspaceId);
      const elsewhere = await openStream(other.owner, other.workspaceId);
      try {
        expect(member.statusCode).toBe(200);
        expect(member.headers['content-type']).toContain('text/event-stream');
        expect(member.headers['cache-control']).toBe('no-cache, no-transform');
        expect(member.headers['x-accel-buffering']).toBe('no');

        const doc = await createDoc(team.editor, team.workspaceId);
        await as(team.editor).patch(`/documents/${doc.id}`).send({ title: 'renamed' }).expect(200);
        await settle();

        const events = eventsOf(member);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({
          event: 'tree.changed',
          data: { workspaceId: team.workspaceId },
        });
        expect(Number(events[1]!.data.version)).toBe(Number(events[0]!.data.version) + 1);
        expect(eventsOf(elsewhere)).toEqual([]);
      } finally {
        member.close();
        elsewhere.close();
      }
    });

    it('answers non-members with 404 and requires a valid workspace id', async () => {
      const team = await setupTeam();
      await as(team.outsider).get(`/events/stream?workspaceId=${team.workspaceId}`).expect(404);
      await as(team.owner).get('/events/stream?workspaceId=nope').expect(400);
      await as(team.owner).get('/events/stream').expect(400);
    });
  });

  describe('access guard coverage', () => {
    it('has no route under documents/:id without a DocumentAccess guard or an explicit service check', async () => {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      for (const file of ['documents.controller.ts', 'shares.controller.ts']) {
        const source = readFileSync(join(__dirname, file), 'utf8');
        const routes = source.split(/\n\s*@(?=Get|Post|Patch|Delete)/).slice(1);
        for (const route of routes) {
          const path = /^\w+\('([^']*)'/.exec(route)?.[1] ?? '';
          if (!path.startsWith('documents/:id')) continue;
          const guarded = route.includes('@DocumentAccess(');
          // restore resolves access itself because the guard treats deleted documents as absent
          const explicit = path === 'documents/:id/restore';
          expect({ path, ok: guarded || explicit }).toEqual({ path, ok: true });
        }
      }
    });
  });
});
