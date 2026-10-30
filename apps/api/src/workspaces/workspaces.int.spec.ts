import '../test/env/workspaces';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { type PrismaClient } from '@collab-docs/db';
import { PERM_EVENT_CHANNELS, type WorkspaceRole, releasedEmail } from '@collab-docs/shared';
import { MailQueueService } from '../mail/mail-queue.service';
import { MailWorkerModule } from '../mail/mail.module';
import { createTestApp } from '../test/test-app';
import { confirmEmail } from '../test/confirm-email';
import { PrismaService } from '../prisma/prisma.service';
import { PlanLimitsService } from './plan-limits.service';

const PASSWORD = 'correct-horse-battery';
const MAILPIT_URL = process.env.MAILPIT_URL;
// the Mailpit assertion needs a running Mailpit (docker compose up -d mailpit; MAILPIT_URL=http://localhost:8025)
const itWithMailpit = MAILPIT_URL ? it : it.skip;

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe('workspaces, members, invites', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let redis: Redis;
  const inviteLinks = new Map<string, string>();
  let counter = 0;
  let ipCounter = 0;

  const http = () => request(app.getHttpServer());
  const nextIp = () => `10.2.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  async function register(label = 'user'): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@ws-test.example`;
    const response = await http()
      .post('/api/auth/register')
      .set('X-Forwarded-For', nextIp())
      .send({ email, password: PASSWORD, name: label })
      .expect(201);
    await confirmEmail(prisma, response.body.user.id);
    return { id: response.body.user.id, email, token: response.body.accessToken };
  }

  const as = (user: TestUser) => ({
    get: (path: string) => http().get(`/api${path}`).set('Authorization', `Bearer ${user.token}`),
    post: (path: string) => http().post(`/api${path}`).set('Authorization', `Bearer ${user.token}`),
    patch: (path: string) =>
      http().patch(`/api${path}`).set('Authorization', `Bearer ${user.token}`),
    delete: (path: string) =>
      http().delete(`/api${path}`).set('Authorization', `Bearer ${user.token}`),
  });

  async function createWorkspace(owner: TestUser, name = 'Acme'): Promise<string> {
    const response = await as(owner).post('/workspaces').send({ name }).expect(201);
    return response.body.id;
  }

  /** Invites `user` with `role` and accepts, so they become a member. */
  async function addMember(
    workspaceId: string,
    inviter: TestUser,
    user: TestUser,
    role: WorkspaceRole,
  ): Promise<void> {
    await as(inviter)
      .post(`/workspaces/${workspaceId}/invites`)
      .send({ email: user.email, role })
      .expect(201);
    await as(user)
      .post(`/invites/${tokenFor(user.email)}/accept`)
      .expect(200);
  }

  function tokenFor(email: string): string {
    const link = inviteLinks.get(email);
    if (!link) throw new Error(`no invite mail captured for ${email}`);
    return link.split('/invite/')[1]!;
  }

  /** workspace with an owner and one member of each other role, plus an outsider */
  async function setupTeam() {
    const [owner, admin, editor, viewer, outsider] = await Promise.all(
      ['owner', 'admin', 'editor', 'viewer', 'outsider'].map(register),
    );
    // FREE allows 3 members: lift to PRO so the whole team fits
    const workspaceId = await createWorkspace(owner!);
    await prisma.subscription.update({ where: { workspaceId }, data: { plan: 'PRO' } });
    await addMember(workspaceId, owner!, admin!, 'ADMIN');
    await addMember(workspaceId, owner!, editor!, 'EDITOR');
    await addMember(workspaceId, owner!, viewer!, 'VIEWER');
    return {
      workspaceId,
      owner: owner!,
      admin: admin!,
      editor: editor!,
      viewer: viewer!,
      outsider: outsider!,
    };
  }

  beforeAll(async () => {
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();
    redis = new Redis(process.env.REDIS_URL as string);
    app = await createTestApp([], [MailWorkerModule]);
    // listening once lets supertest reuse the address; without it every one of the parallel requests below
    // would start the server itself, piling up listeners on one http.Server
    await app.listen(0, '127.0.0.1');
    prisma = app.get(PrismaService, { strict: false });

    // capture the invite links regardless of whether a Mailpit is running; delivery still happens through the queue
    const mailQueue = app.get(MailQueueService, { strict: false });
    // the accounts are confirmed by `confirmEmail`; the confirmation emails of their sign-up would only add noise
    jest.spyOn(mailQueue, 'sendVerifyEmail').mockResolvedValue(undefined);
    const original = mailQueue.sendInvite.bind(mailQueue);
    jest.spyOn(mailQueue, 'sendInvite').mockImplementation((job) => {
      inviteLinks.set(job.to, job.link);
      return original(job);
    });
  });

  afterAll(async () => {
    redis.disconnect();
    await app.close();
  });

  describe('flow', () => {
    it('creates a workspace, invites by email, accepts the invite and lists the member', async () => {
      const owner = await register('flow-owner');
      const invitee = await register('flow-invitee');
      // the invitation reached this address, so accepting it confirms the address
      await prisma.user.update({ where: { id: invitee.id }, data: { emailVerifiedAt: null } });

      const created = await as(owner)
        .post('/workspaces')
        .send({ name: '  Acme Inc.  ' })
        .expect(201);
      expect(created.body).toMatchObject({ name: 'Acme Inc.', role: 'OWNER', plan: 'FREE' });
      expect(created.body.slug).toMatch(/^acme-inc-[0-9a-f]{6}$/);
      const workspaceId = created.body.id as string;

      const subscription = await prisma.subscription.findUnique({ where: { workspaceId } });
      expect(subscription).toMatchObject({ plan: 'FREE', status: 'ACTIVE' });

      const invite = await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: invitee.email.toUpperCase(), role: 'EDITOR' })
        .expect(201);
      expect(invite.body).toMatchObject({ email: invitee.email, role: 'EDITOR' });
      expect(invite.body).not.toHaveProperty('token');
      expect(invite.body).not.toHaveProperty('tokenHash');

      // only the hash is stored
      const stored = await prisma.workspaceInvite.findUniqueOrThrow({
        where: { id: invite.body.id },
      });
      const token = tokenFor(invitee.email);
      expect(stored.tokenHash).not.toBe(token);
      expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);

      // preview is public
      const preview = await http().get(`/api/invites/${token}`).expect(200);
      expect(preview.body).toMatchObject({
        workspaceName: 'Acme Inc.',
        email: invitee.email,
        role: 'EDITOR',
        inviterName: 'flow-owner',
      });

      expect((await as(invitee).post(`/invites/${token}/accept`).expect(200)).body).toEqual({
        workspaceId,
        role: 'EDITOR',
      });
      expect((await as(invitee).get('/auth/me').expect(200)).body).toMatchObject({
        emailVerified: true,
      });

      const members = await as(owner).get(`/workspaces/${workspaceId}/members`).expect(200);
      expect(members.body.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual(
        expect.arrayContaining([
          [owner.email, 'OWNER'],
          [invitee.email, 'EDITOR'],
        ]),
      );

      const mine = await as(invitee).get('/workspaces').expect(200);
      expect(mine.body).toEqual([expect.objectContaining({ id: workspaceId, role: 'EDITOR' })]);
      await http().get(`/api/invites/${token}`).expect(400);
    });

    it('requires authentication', async () => {
      await http().get('/api/workspaces').expect(401);
      await http().post('/api/workspaces').send({ name: 'x' }).expect(401);
      await http()
        .post(`/api/invites/${'a'.repeat(43)}/accept`)
        .expect(401);
    });

    it('validates input', async () => {
      const owner = await register();
      await as(owner).post('/workspaces').send({ name: '' }).expect(400);
      await as(owner).post('/workspaces').send({ name: 'x', extra: 1 }).expect(400);
      const workspaceId = await createWorkspace(owner);
      await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: 'not-an-email', role: 'EDITOR' })
        .expect(400);
      const ownerRole = await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: 'x@example.test', role: 'OWNER' })
        .expect(400);
      expect(ownerRole.body.code).toBe('VALIDATION_FAILED');
    });

    itWithMailpit('delivers the invitation email to Mailpit', async () => {
      const owner = await register('mail-owner');
      const invitee = await register('mail-invitee');
      const workspaceId = await createWorkspace(owner, 'Mail <Test> Workspace');
      await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: invitee.email, role: 'VIEWER' })
        .expect(201);

      const deadline = Date.now() + 15_000;
      let message: { ID: string } | undefined;
      while (!message && Date.now() < deadline) {
        const search = await fetch(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${invitee.email}`)}`,
        );
        const body = (await search.json()) as { messages: Array<{ ID: string }> };
        message = body.messages[0];
        if (!message) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!message) throw new Error('invitation email did not reach Mailpit');
      const detail = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`)
      ).json()) as {
        Subject: string;
        Text: string;
        HTML: string;
      };
      expect(detail.Subject).toContain('mail-owner invited you to');
      expect(detail.Text).toContain(tokenFor(invitee.email));
      expect(detail.HTML).toContain('Mail &lt;Test&gt; Workspace');
      expect(detail.HTML).not.toContain('<Test>');
    });
  });

  describe('permission matrix', () => {
    type Probe = {
      name: string;
      call: (user: TestUser, ctx: { workspaceId: string; viewerId: string }) => request.Test;
      /** Lowest role that succeeds. */
      min: WorkspaceRole;
      ok: number;
    };
    const probes: Probe[] = [
      {
        name: 'GET /workspaces/:id',
        call: (u, c) => as(u).get(`/workspaces/${c.workspaceId}`),
        min: 'VIEWER',
        ok: 200,
      },
      {
        name: 'PATCH /workspaces/:id',
        call: (u, c) => as(u).patch(`/workspaces/${c.workspaceId}`).send({ name: 'Renamed' }),
        min: 'ADMIN',
        ok: 200,
      },
      {
        name: 'GET /workspaces/:id/usage',
        call: (u, c) => as(u).get(`/workspaces/${c.workspaceId}/usage`),
        min: 'VIEWER',
        ok: 200,
      },
      {
        name: 'GET /workspaces/:id/members',
        call: (u, c) => as(u).get(`/workspaces/${c.workspaceId}/members`),
        min: 'VIEWER',
        ok: 200,
      },
      {
        name: 'PATCH /workspaces/:id/members/:userId',
        call: (u, c) =>
          as(u)
            .patch(`/workspaces/${c.workspaceId}/members/${c.viewerId}`)
            .send({ role: 'VIEWER' }),
        min: 'ADMIN',
        ok: 200,
      },
      {
        name: 'POST /workspaces/:id/invites',
        call: (u, c) =>
          as(u)
            .post(`/workspaces/${c.workspaceId}/invites`)
            .send({ email: `probe-${counter++}@example.test`, role: 'VIEWER' }),
        min: 'ADMIN',
        ok: 201,
      },
      {
        name: 'GET /workspaces/:id/invites',
        call: (u, c) => as(u).get(`/workspaces/${c.workspaceId}/invites`),
        min: 'ADMIN',
        ok: 200,
      },
      {
        name: 'DELETE /workspaces/:id/invites/:inviteId',
        call: (u, c) =>
          as(u).delete(`/workspaces/${c.workspaceId}/invites/0190b1c2-0000-7000-8000-0000000000aa`),
        min: 'ADMIN',
        // the invite does not exist: an authorised caller gets 404 too, which is what we check below
        ok: 404,
      },
    ];
    const order: WorkspaceRole[] = ['VIEWER', 'EDITOR', 'ADMIN', 'OWNER'];

    it.each(probes)('$name: role gates and hides the workspace from outsiders', async (probe) => {
      const team = await setupTeam();
      const ctx = { workspaceId: team.workspaceId, viewerId: team.viewer.id };
      const users: Record<WorkspaceRole, TestUser> = {
        VIEWER: team.viewer,
        EDITOR: team.editor,
        ADMIN: team.admin,
        OWNER: team.owner,
      };

      // outsiders see exactly what an unknown workspace looks like
      const unknown = await probe.call(team.outsider, {
        ...ctx,
        workspaceId: '0190b1c2-0000-7000-8000-0000000000bb',
      });
      const outsider = await probe.call(team.outsider, ctx);
      expect(outsider.status).toBe(404);
      expect(outsider.body).toEqual({
        ...unknown.body,
        correlationId: outsider.body.correlationId,
      });
      expect(JSON.stringify(outsider.body)).not.toContain(team.owner.email);

      for (const role of order) {
        // use a fresh team member per probe so a destructive call does not affect the next role
        const response = await probe.call(users[role], ctx);
        const allowed = order.indexOf(role) >= order.indexOf(probe.min);
        expect(response.status).toBe(allowed ? probe.ok : 403);
      }
    });

    it('rejects a malformed workspace id as not found', async () => {
      const user = await register();
      await as(user).get('/workspaces/not-a-uuid').expect(404);
    });
  });

  describe('members', () => {
    it('applies the role-change rules', async () => {
      const team = await setupTeam();
      const base = `/workspaces/${team.workspaceId}/members`;

      // an admin cannot touch the owner or grant OWNER
      await as(team.admin).patch(`${base}/${team.owner.id}`).send({ role: 'VIEWER' }).expect(403);
      await as(team.admin).patch(`${base}/${team.editor.id}`).send({ role: 'OWNER' }).expect(403);
      await as(team.admin).delete(`${base}/${team.owner.id}`).expect(403);

      // the last owner cannot be demoted or leave
      const demote = await as(team.owner)
        .patch(`${base}/${team.owner.id}`)
        .send({ role: 'ADMIN' })
        .expect(409);
      expect(demote.body.code).toBe('CONFLICT');
      await as(team.owner).delete(`${base}/${team.owner.id}`).expect(409);

      // an admin can demote an editor, an owner can promote to OWNER
      const changed = await as(team.admin)
        .patch(`${base}/${team.editor.id}`)
        .send({ role: 'VIEWER' })
        .expect(200);
      expect(changed.body).toMatchObject({ userId: team.editor.id, role: 'VIEWER' });
      await as(team.owner).patch(`${base}/${team.admin.id}`).send({ role: 'OWNER' }).expect(200);

      // with two owners the first one may step down and leave
      await as(team.owner).patch(`${base}/${team.owner.id}`).send({ role: 'ADMIN' }).expect(200);
      await as(team.owner).delete(`${base}/${team.owner.id}`).expect(204);
      await as(team.owner).get(`/workspaces/${team.workspaceId}`).expect(404);

      // a member can leave on their own, but cannot remove others
      await as(team.viewer).delete(`${base}/${team.editor.id}`).expect(403);
      await as(team.viewer).delete(`${base}/${team.viewer.id}`).expect(204);
      await as(team.admin).delete(`${base}/${team.viewer.id}`).expect(404);
    });

    it('serialises concurrent demotions so one owner always remains', async () => {
      const team = await setupTeam();
      const base = `/workspaces/${team.workspaceId}/members`;
      await as(team.owner).patch(`${base}/${team.admin.id}`).send({ role: 'OWNER' }).expect(200);

      const results = await Promise.all([
        as(team.owner).patch(`${base}/${team.admin.id}`).send({ role: 'VIEWER' }),
        as(team.admin).patch(`${base}/${team.owner.id}`).send({ role: 'VIEWER' }),
      ]);
      // the loser was either demoted before it got the lock (403) or would have removed the last owner (409)
      const statuses = results.map((r) => r.status).sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
      const owners = await prisma.workspaceMember.count({
        where: { workspaceId: team.workspaceId, role: 'OWNER' },
      });
      expect(owners).toBe(1);
    });

    it('takes away the documents shared with a removed member, and a member who leaves', async () => {
      const team = await setupTeam();
      const base = `/workspaces/${team.workspaceId}/members`;
      const restricted = async () => {
        const doc = await as(team.owner)
          .post(`/workspaces/${team.workspaceId}/documents`)
          .send({ title: 'Payroll' })
          .expect(201);
        const id = (doc.body as { id: string }).id;
        await as(team.owner)
          .patch(`/documents/${id}`)
          .send({ visibility: 'RESTRICTED' })
          .expect(200);
        return id;
      };
      const forEditor = await restricted();
      const forViewer = await restricted();
      for (const [id, user] of [
        [forEditor, team.editor],
        [forViewer, team.viewer],
      ] as const) {
        await as(team.owner)
          .post(`/documents/${id}/shares`)
          .send({ email: user.email, role: 'EDITOR' })
          .expect(201);
        await as(user).get(`/documents/${id}`).expect(200);
      }

      await as(team.owner).delete(`${base}/${team.editor.id}`).expect(204);
      await as(team.viewer).delete(`${base}/${team.viewer.id}`).expect(204);

      for (const [id, user] of [
        [forEditor, team.editor],
        [forViewer, team.viewer],
      ] as const) {
        await as(user).get(`/documents/${id}`).expect(404);
        await as(user).patch(`/documents/${id}`).send({ title: 'mine now' }).expect(404);
        // the ticket is what opens the WebSocket
        await as(user).post(`/documents/${id}/collab-ticket`).expect(404);
        expect((await as(user).get('/me/shared-documents').expect(200)).body).toEqual([]);
      }
      expect(
        await prisma.documentShare.count({ where: { documentId: { in: [forEditor, forViewer] } } }),
      ).toBe(0);
    });

    it('publishes perm.changed after a role change and a removal', async () => {
      const team = await setupTeam();
      const subscriber = new Redis(process.env.REDIS_URL as string);
      const messages: Array<Record<string, unknown>> = [];
      // the channel is global: other suites run in parallel and publish their own events, so keep only ours
      subscriber.on('message', (_channel, payload) => {
        const event = JSON.parse(payload) as Record<string, unknown>;
        if (event.workspaceId === team.workspaceId) messages.push(event);
      });
      await subscriber.subscribe(PERM_EVENT_CHANNELS.permChanged);
      try {
        const base = `/workspaces/${team.workspaceId}/members`;
        await as(team.owner)
          .patch(`${base}/${team.editor.id}`)
          .send({ role: 'VIEWER' })
          .expect(200);
        await as(team.owner).delete(`${base}/${team.viewer.id}`).expect(204);
        const deadline = Date.now() + 5000;
        while (messages.length < 2 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(messages).toEqual([
          expect.objectContaining({
            workspaceId: team.workspaceId,
            userId: team.editor.id,
            reason: 'role_changed',
          }),
          expect.objectContaining({
            workspaceId: team.workspaceId,
            userId: team.viewer.id,
            reason: 'member_removed',
          }),
        ]);
      } finally {
        subscriber.disconnect();
      }
    });
  });

  describe('invites', () => {
    it('rejects members, re-issues pending invites and revokes them', async () => {
      const team = await setupTeam();
      const invitee = await register('invitee');
      const path = `/workspaces/${team.workspaceId}/invites`;

      // already a member
      await as(team.owner)
        .post(path)
        .send({ email: team.editor.email, role: 'VIEWER' })
        .expect(409);

      const first = await as(team.owner)
        .post(path)
        .send({ email: invitee.email, role: 'VIEWER' })
        .expect(201);
      const oldToken = tokenFor(invitee.email);
      const second = await as(team.admin)
        .post(path)
        .send({ email: invitee.email, role: 'EDITOR' })
        .expect(201);
      const newToken = tokenFor(invitee.email);

      // one pending invite, new token, updated role
      expect(second.body.id).toBe(first.body.id);
      expect(newToken).not.toBe(oldToken);
      expect(second.body.role).toBe('EDITOR');
      await http().get(`/api/invites/${oldToken}`).expect(400);
      await http().get(`/api/invites/${newToken}`).expect(200);
      expect((await as(team.owner).get(path).expect(200)).body).toHaveLength(1);

      await as(team.owner).delete(`${path}/${first.body.id}`).expect(204);
      await as(team.owner).delete(`${path}/${first.body.id}`).expect(404);
      const revoked = await as(invitee).post(`/invites/${newToken}/accept`).expect(400);
      expect(revoked.body.code).toBe('INVITE_INVALID');
    });

    it('does not invite the placeholder address of a released account', async () => {
      const owner = await register();
      const workspaceId = await createWorkspace(owner);
      const denied = await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: releasedEmail(owner.id), role: 'VIEWER' })
        .expect(400);
      expect(denied.body.code).toBe('VALIDATION_FAILED');
      expect(await prisma.workspaceInvite.count({ where: { workspaceId } })).toBe(0);
    });

    it('refuses an account with a different email, and keeps the invite usable', async () => {
      const team = await setupTeam();
      const invitee = await register('right');
      await as(team.owner)
        .post(`/workspaces/${team.workspaceId}/invites`)
        .send({ email: invitee.email, role: 'VIEWER' })
        .expect(201);
      const token = tokenFor(invitee.email);

      const denied = await as(team.outsider).post(`/invites/${token}/accept`).expect(403);
      expect(denied.body.code).toBe('FORBIDDEN');
      await as(invitee).post(`/invites/${token}/accept`).expect(200);
    });

    it('rejects expired, malformed and already used tokens', async () => {
      const owner = await register();
      const invitee = await register();
      const workspaceId = await createWorkspace(owner);
      const invite = await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: invitee.email, role: 'VIEWER' })
        .expect(201);
      const token = tokenFor(invitee.email);

      await http().get('/api/invites/short').expect(400);
      await http()
        .get(`/api/invites/${'z'.repeat(43)}`)
        .expect(400);

      await prisma.workspaceInvite.update({
        where: { id: invite.body.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await http().get(`/api/invites/${token}`).expect(400);
      await as(invitee).post(`/invites/${token}/accept`).expect(400);
      // an expired pending invite does not occupy a slot
      expect((await as(owner).get(`/workspaces/${workspaceId}/usage`)).body.members).toMatchObject({
        current: 1,
        pendingInvites: 0,
      });

      // re-inviting revives it
      await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: invitee.email, role: 'VIEWER' })
        .expect(201);
      const fresh = tokenFor(invitee.email);
      await as(invitee).post(`/invites/${fresh}/accept`).expect(200);
      await as(invitee).post(`/invites/${fresh}/accept`).expect(400);
    });

    it('joins nothing when the account lost its address while the invitation was accepted', async () => {
      const owner = await register();
      const invitee = await register();
      const workspaceId = await createWorkspace(owner);
      await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: invitee.email, role: 'VIEWER' })
        .expect(201);
      const token = tokenFor(invitee.email);

      // released to a new registration after the address was compared and before the acceptance ends
      const limits = app.get(PlanLimitsService, { strict: false });
      const check = limits.assertCanAddMember.bind(limits);
      jest.spyOn(limits, 'assertCanAddMember').mockImplementationOnce(async (...args) => {
        await prisma.user.update({
          where: { id: invitee.id },
          data: { email: releasedEmail(invitee.id), emailVerifiedAt: null },
        });
        return check(...args);
      });

      const denied = await as(invitee).post(`/invites/${token}/accept`).expect(403);
      expect(denied.body.code).toBe('FORBIDDEN');
      expect(
        await prisma.workspaceMember.count({ where: { workspaceId, userId: invitee.id } }),
      ).toBe(0);
      expect(
        await prisma.workspaceInvite.count({ where: { workspaceId, acceptedAt: { not: null } } }),
      ).toBe(0);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: invitee.id } })).emailVerifiedAt,
      ).toBeNull();
    });

    it('lets exactly one of two parallel accepts through', async () => {
      const owner = await register();
      const invitee = await register();
      const workspaceId = await createWorkspace(owner);
      await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: invitee.email, role: 'VIEWER' })
        .expect(201);
      const token = tokenFor(invitee.email);
      const results = await Promise.all([
        as(invitee).post(`/invites/${token}/accept`),
        as(invitee).post(`/invites/${token}/accept`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      expect(
        await prisma.workspaceMember.count({ where: { workspaceId, userId: invitee.id } }),
      ).toBe(1);
    });
  });

  describe('plan limits', () => {
    it('counts pending invites, reports PLAN_LIMIT_EXCEEDED details and frees slots on revoke', async () => {
      const owner = await register();
      const workspaceId = await createWorkspace(owner);
      const path = `/workspaces/${workspaceId}/invites`;

      const a = await as(owner)
        .post(path)
        .send({ email: `a-${counter++}@example.test`, role: 'VIEWER' })
        .expect(201);
      await as(owner)
        .post(path)
        .send({ email: `b-${counter++}@example.test`, role: 'VIEWER' })
        .expect(201);

      const blocked = await as(owner)
        .post(path)
        .send({ email: `c-${counter++}@example.test`, role: 'VIEWER' })
        .expect(403);
      expect(blocked.body).toMatchObject({
        statusCode: 403,
        code: 'PLAN_LIMIT_EXCEEDED',
        details: { kind: 'members', limit: 3, current: 3, plan: 'FREE' },
      });

      const usage = await as(owner).get(`/workspaces/${workspaceId}/usage`).expect(200);
      expect(usage.body).toEqual({
        plan: 'FREE',
        members: { current: 1, pendingInvites: 2, limit: 3 },
        documents: { current: 0, limit: 20 },
        storage: { currentBytes: 0, limitBytes: 100 * 1024 * 1024 },
      });

      await as(owner).delete(`${path}/${a.body.id}`).expect(204);
      await as(owner)
        .post(path)
        .send({ email: `c-${counter++}@example.test`, role: 'VIEWER' })
        .expect(201);

      // a higher plan raises the limit
      await prisma.subscription.update({ where: { workspaceId }, data: { plan: 'PRO' } });
      await as(owner)
        .post(path)
        .send({ email: `d-${counter++}@example.test`, role: 'VIEWER' })
        .expect(201);
      expect((await as(owner).get(`/workspaces/${workspaceId}/usage`)).body.members.limit).toBe(10);
    });

    it('does not count document guests as members', async () => {
      const owner = await register();
      const guest = await register();
      const workspaceId = await createWorkspace(owner);
      const document = await prisma.document.create({
        data: { workspaceId, createdBy: owner.id, position: 'a0', title: 'Shared' },
      });
      await prisma.documentShare.create({
        data: { documentId: document.id, userId: guest.id, role: 'VIEWER' },
      });
      const usage = await as(owner).get(`/workspaces/${workspaceId}/usage`).expect(200);
      expect(usage.body.members).toMatchObject({ current: 1, pendingInvites: 0 });
      expect(usage.body.documents.current).toBe(1);
    });

    it('allows exactly the limit under parallel invites', async () => {
      const owner = await register();
      const workspaceId = await createWorkspace(owner);
      const attempts = 10;
      const responses = await Promise.all(
        Array.from({ length: attempts }, () =>
          as(owner)
            .post(`/workspaces/${workspaceId}/invites`)
            .send({ email: `race-${counter++}@example.test`, role: 'VIEWER' }),
        ),
      );
      const statuses = responses.map((r) => r.status);
      // FREE plan: 3 slots, the owner takes one
      expect(statuses.filter((s) => s === 201)).toHaveLength(2);
      expect(statuses.filter((s) => s === 403)).toHaveLength(attempts - 2);
      expect(await prisma.workspaceInvite.count({ where: { workspaceId } })).toBe(2);
    });

    it('blocks accepting when a downgrade left the workspace over its limit', async () => {
      const owner = await register();
      const invitee = await register();
      const workspaceId = await createWorkspace(owner);
      await prisma.subscription.update({ where: { workspaceId }, data: { plan: 'PRO' } });
      const others = await Promise.all([register(), register()]);
      for (const user of others) await addMember(workspaceId, owner, user, 'VIEWER');
      await as(owner)
        .post(`/workspaces/${workspaceId}/invites`)
        .send({ email: invitee.email, role: 'VIEWER' })
        .expect(201);
      // 3 members + 1 pending on PRO; a downgrade to FREE (limit 3) leaves the existing members in place
      await prisma.subscription.update({ where: { workspaceId }, data: { plan: 'FREE' } });
      const blocked = await as(invitee)
        .post(`/invites/${tokenFor(invitee.email)}/accept`)
        .expect(403);
      expect(blocked.body.code).toBe('PLAN_LIMIT_EXCEEDED');
      expect(await prisma.workspaceMember.count({ where: { workspaceId } })).toBe(3);
    });
  });
});
