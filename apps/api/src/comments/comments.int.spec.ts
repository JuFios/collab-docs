import '../test/comments-env';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as Y from 'yjs';
import { DocumentStateWriter, type PrismaClient } from '@collab-docs/db';
import type {
  MentionableUser,
  NotificationPage,
  ThreadResponse,
  CommentResponse,
} from '@collab-docs/shared';
import { QUEUE_NAMES, QueueService } from '@collab-docs/nest';
import { createTestApp } from '../test/test-app';
import { NotificationsService } from '../notifications/notifications.service';
import { MailQueueService } from '../mail/mail-queue.service';
import { MailerService, type MailMessage } from '../mail/mailer.service';
import { MailWorkerModule } from '../mail/mail.module';
import { MentionMailService } from '../mail/mention-mail.service';
import { PrismaService } from '../prisma/prisma.service';

const PASSWORD = 'correct-horse-battery';
const UNKNOWN_ID = '0198d6c0-0000-7000-8000-000000000000';
const MAILPIT_URL = process.env.MAILPIT_URL;
// the Mailpit assertion needs a running Mailpit (docker compose up -d mailpit; MAILPIT_URL=http://localhost:8025)
const itWithMailpit = MAILPIT_URL ? it : it.skip;

interface TestUser {
  id: string;
  token: string;
  email: string;
  name: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await wait(25);
  }
}

const mention = (user: TestUser) => `@[${user.id}]`;

describe('comments and notifications', () => {
  let app: NestExpressApplication;
  let prisma: PrismaClient;
  let writer: DocumentStateWriter;
  let notifications: NotificationsService;
  let mailer: MailerService;
  let counter = 0;
  const drafts = new Map<string, Y.Doc>();
  /** Every email the worker rendered; `send` still goes to Mailpit when one is configured. */
  const sent: MailMessage[] = [];

  const http$ = () => request(app.getHttpServer());

  async function register(label: string): Promise<TestUser> {
    const email = `${label}-${Date.now()}-${counter++}@comments-test.example`;
    const name = `${label} ${counter}`;
    const response = await http$()
      .post('/api/auth/register')
      .set('X-Forwarded-For', `10.4.${counter % 250}.${(counter * 7) % 250}`)
      .send({ email, password: PASSWORD, name })
      .expect(201);
    return { id: response.body.user.id, email, name, token: response.body.accessToken };
  }

  const as = (user: TestUser | null) => {
    const auth = <T extends request.Test>(req: T): T =>
      (user ? req.set('Authorization', `Bearer ${user.token}`) : req) as T;
    return {
      get: (path: string) => auth(http$().get(`/api${path}`)),
      post: (path: string) => auth(http$().post(`/api${path}`)),
      patch: (path: string) => auth(http$().patch(`/api${path}`)),
      delete: (path: string) => auth(http$().delete(`/api${path}`)),
    };
  };

  /** A workspace with every role in it, and a guest (editor share), a read-only guest and an outsider beside it. */
  async function setup() {
    const [owner, admin, editor, editor2, viewer, guest, readGuest, outsider] = await Promise.all(
      ['owner', 'admin', 'editor', 'editor2', 'viewer', 'guest', 'readguest', 'outsider'].map(
        register,
      ),
    );
    const workspace = await as(owner!).post('/workspaces').send({ name: 'Docs' }).expect(201);
    const workspaceId = workspace.body.id as string;
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: admin!.id, role: 'ADMIN' },
        { workspaceId, userId: editor!.id, role: 'EDITOR' },
        { workspaceId, userId: editor2!.id, role: 'EDITOR' },
        { workspaceId, userId: viewer!.id, role: 'VIEWER' },
      ],
    });
    return {
      owner: owner!,
      admin: admin!,
      editor: editor!,
      editor2: editor2!,
      viewer: viewer!,
      guest: guest!,
      readGuest: readGuest!,
      outsider: outsider!,
      workspaceId,
    };
  }

  async function createDocument(user: TestUser, workspaceId: string, title = 'Spec') {
    const created = await as(user)
      .post(`/workspaces/${workspaceId}/documents`)
      .send({ title })
      .expect(201);
    return created.body.id as string;
  }

  const shareWith = async (owner: TestUser, documentId: string, user: TestUser, role: string) => {
    await as(owner)
      .post(`/documents/${documentId}/shares`)
      .send({ email: user.email, role })
      .expect(201);
  };

  const block = (id: string, text: string) => {
    const element = new Y.XmlElement('paragraph');
    element.setAttribute('id', id);
    const node = new Y.XmlText();
    element.insert(0, [node]);
    node.insert(0, text);
    return element;
  };

  /** Stores a document made of paragraphs with the given block ids, the way a flush of the collab service does. */
  async function setBlocks(documentId: string, ...ids: string[]) {
    let doc = drafts.get(documentId);
    if (!doc) drafts.set(documentId, (doc = new Y.Doc()));
    const before = Y.encodeStateVector(doc);
    doc.transact(() => {
      const fragment = (doc as Y.Doc).getXmlFragment('content');
      fragment.delete(0, fragment.length);
      fragment.insert(
        0,
        ids.map((id) => block(id, `text of ${id}`)),
      );
    });
    await writer.append(documentId, Y.encodeStateAsUpdate(doc, before));
  }

  interface Written {
    thread: ThreadResponse;
    warnings: Array<{ code: string; userId: string }>;
  }

  async function startThread(
    user: TestUser,
    documentId: string,
    body: string,
    blockId = 'block-1',
  ): Promise<Written> {
    const response = await as(user)
      .post(`/documents/${documentId}/threads`)
      .send({ blockId, body })
      .expect(201);
    return response.body as Written;
  }

  async function reply(user: TestUser, threadId: string, body: string) {
    const response = await as(user)
      .post(`/threads/${threadId}/comments`)
      .send({ body })
      .expect(201);
    return response.body as { comment: CommentResponse; warnings: Written['warnings'] };
  }

  const threadsOf = async (user: TestUser, documentId: string, query = '') =>
    (await as(user).get(`/documents/${documentId}/threads${query}`).expect(200))
      .body as ThreadResponse[];

  const notificationsOf = async (user: TestUser, query = '') =>
    (await as(user).get(`/notifications${query}`).expect(200)).body as NotificationPage;

  const unreadOf = async (user: TestUser) =>
    ((await as(user).get('/notifications/unread-count').expect(200)).body as { count: number })
      .count;

  const rowsFor = (userId: string) => prisma.notification.findMany({ where: { userId } });

  beforeAll(async () => {
    const { Redis } = await import('ioredis');
    const flush = new Redis(process.env.REDIS_URL as string);
    await flush.flushdb();
    flush.disconnect();
    app = await createTestApp([], [MailWorkerModule]);
    prisma = app.get(PrismaService, { strict: false });
    writer = new DocumentStateWriter(prisma);
    notifications = app.get(NotificationsService, { strict: false });
    mailer = app.get(MailerService, { strict: false });
    const send = mailer.send.bind(mailer);
    jest.spyOn(mailer, 'send').mockImplementation(async (message) => {
      sent.push(message);
      if (MAILPIT_URL) await send(message);
    });
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('permissions', () => {
    it('requires authentication', async () => {
      await http$().get(`/api/documents/${UNKNOWN_ID}/threads`).expect(401);
      await http$().post(`/api/threads/${UNKNOWN_ID}/comments`).send({ body: 'x' }).expect(401);
      await http$().patch(`/api/comments/${UNKNOWN_ID}`).send({ body: 'x' }).expect(401);
      await http$().delete(`/api/comments/${UNKNOWN_ID}`).expect(401);
      await http$().get('/api/notifications').expect(401);
      await http$().get('/api/notifications/unread-count').expect(401);
      await http$().post('/api/notifications/read').send({ all: true }).expect(401);
    });

    it('lets a viewer read threads but not write; editors, admins and owners write', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, 'First');

      expect(await threadsOf(team.viewer, documentId)).toHaveLength(1);
      await as(team.viewer)
        .post(`/documents/${documentId}/threads`)
        .send({ blockId: 'block-1', body: 'no' })
        .expect(403);
      await as(team.viewer).post(`/threads/${thread.id}/comments`).send({ body: 'no' }).expect(403);
      await as(team.viewer).post(`/threads/${thread.id}/resolve`).expect(403);
      await as(team.viewer).get(`/documents/${documentId}/mentionable`).expect(403);

      for (const user of [team.editor2, team.admin, team.owner]) {
        await reply(user, thread.id, `from ${user.name}`);
      }
      expect((await threadsOf(team.viewer, documentId))[0]!.comments).toHaveLength(4);
    });

    it('answers 404 to people with no access to the document, whatever the route', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, 'Hello');
      const comment = thread.comments[0]!;

      for (const stranger of [team.outsider, team.guest]) {
        await as(stranger).get(`/documents/${documentId}/threads`).expect(404);
        await as(stranger)
          .post(`/documents/${documentId}/threads`)
          .send({ blockId: 'a', body: 'x' })
          .expect(404);
        await as(stranger).get(`/documents/${documentId}/mentionable`).expect(404);
        await as(stranger).post(`/threads/${thread.id}/comments`).send({ body: 'x' }).expect(404);
        await as(stranger).post(`/threads/${thread.id}/resolve`).expect(404);
        await as(stranger).post(`/threads/${thread.id}/reopen`).expect(404);
        await as(stranger).patch(`/comments/${comment.id}`).send({ body: 'x' }).expect(404);
        await as(stranger).delete(`/comments/${comment.id}`).expect(404);
      }
      // nothing changed
      expect((await threadsOf(team.owner, documentId))[0]).toMatchObject({ resolved: false });
      expect((await threadsOf(team.owner, documentId))[0]!.comments).toHaveLength(1);
    });

    it('answers 404 for ids that do not exist, and 400 for ids that are not uuids', async () => {
      const team = await setup();
      await as(team.owner).get(`/documents/${UNKNOWN_ID}/threads`).expect(404);
      await as(team.owner).post(`/threads/${UNKNOWN_ID}/comments`).send({ body: 'x' }).expect(404);
      await as(team.owner).post(`/threads/${UNKNOWN_ID}/resolve`).expect(404);
      await as(team.owner).patch(`/comments/${UNKNOWN_ID}`).send({ body: 'x' }).expect(404);
      await as(team.owner).delete(`/comments/${UNKNOWN_ID}`).expect(404);
      await as(team.owner).post('/threads/nope/comments').send({ body: 'x' }).expect(400);
      await as(team.owner).delete('/comments/nope').expect(400);
    });

    it('does not let a user from another workspace reach threads by id (IDOR)', async () => {
      const mine = await setup();
      const theirs = await setup();
      const mineDoc = await createDocument(mine.owner, mine.workspaceId);
      const theirDoc = await createDocument(theirs.owner, theirs.workspaceId);
      const { thread } = await startThread(theirs.editor, theirDoc, 'Secret plans');

      // the caller has rights in their own workspace, which says nothing about the thread's document
      await as(mine.owner).post(`/threads/${thread.id}/comments`).send({ body: 'hi' }).expect(404);
      await as(mine.owner).post(`/threads/${thread.id}/resolve`).expect(404);
      await as(mine.owner)
        .patch(`/comments/${thread.comments[0]!.id}`)
        .send({ body: 'x' })
        .expect(404);
      await as(mine.owner).delete(`/comments/${thread.comments[0]!.id}`).expect(404);
      await as(mine.owner).get(`/documents/${theirDoc}/threads`).expect(404);
      expect(await threadsOf(mine.owner, mineDoc)).toEqual([]);
      expect(await threadsOf(theirs.owner, theirDoc)).toHaveLength(1);
    });

    it('treats a restricted document as invisible without a share, and honours the share role', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      await as(team.owner)
        .patch(`/documents/${documentId}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      const { thread } = await startThread(team.owner, documentId, 'Private');

      await as(team.editor).get(`/documents/${documentId}/threads`).expect(404);
      await as(team.editor).post(`/threads/${thread.id}/comments`).send({ body: 'x' }).expect(404);

      await shareWith(team.owner, documentId, team.guest, 'EDITOR');
      await shareWith(team.owner, documentId, team.readGuest, 'VIEWER');
      expect(await threadsOf(team.readGuest, documentId)).toHaveLength(1);
      await as(team.readGuest)
        .post(`/threads/${thread.id}/comments`)
        .send({ body: 'x' })
        .expect(403);
      await reply(team.guest, thread.id, 'Guest here');

      // revoking the share closes it at once
      await as(team.owner).delete(`/documents/${documentId}/shares/${team.guest.id}`).expect(204);
      await as(team.guest).get(`/documents/${documentId}/threads`).expect(404);
      await as(team.guest).post(`/threads/${thread.id}/comments`).send({ body: 'x' }).expect(404);
    });

    it('hides the threads of a document in the trash', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, 'Hello');
      await as(team.owner).delete(`/documents/${documentId}`).expect(204);
      await as(team.owner).get(`/documents/${documentId}/threads`).expect(404);
      await as(team.editor).post(`/threads/${thread.id}/comments`).send({ body: 'x' }).expect(404);
      await as(team.owner).post(`/documents/${documentId}/restore`).expect(200);
      expect(await threadsOf(team.owner, documentId)).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('checks block ids, body length and emptiness', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const post = (body: object) =>
        as(team.editor).post(`/documents/${documentId}/threads`).send(body);

      for (const blockId of [
        '',
        'a b',
        'a/b',
        '<x>',
        'x'.repeat(65),
        "a'; DROP TABLE comments;--",
      ]) {
        const response = await post({ blockId, body: 'x' }).expect(400);
        expect(response.body.code).toBe('VALIDATION_FAILED');
      }
      await post({ body: 'x' }).expect(400);
      await post({ blockId: 'a' }).expect(400);
      await post({ blockId: 'a', body: '' }).expect(400);
      await post({ blockId: 'a', body: '   \n ' }).expect(400);
      await post({ blockId: 'a', body: 7 }).expect(400);
      await post({ blockId: 'a', body: 'x'.repeat(4001) }).expect(400);
      await post({ blockId: 'a', body: 'x', extra: true }).expect(400);
      await post({ blockId: 'x'.repeat(64), body: 'x'.repeat(4000) }).expect(201);
      expect(await threadsOf(team.editor, documentId)).toHaveLength(1);
    });

    it('rejects a comment that is nothing but refused mentions', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const response = await as(team.editor)
        .post(`/documents/${documentId}/threads`)
        .send({ blockId: 'a', body: `@[${UNKNOWN_ID}]` })
        .expect(400);
      expect(response.body.code).toBe('VALIDATION_FAILED');
    });

    it('validates the filters and the notification requests', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      await as(team.owner).get(`/documents/${documentId}/threads?status=nope`).expect(400);
      await as(team.owner).get('/notifications?limit=0').expect(400);
      await as(team.owner).get('/notifications?limit=51').expect(400);
      await as(team.owner).get('/notifications?cursor=garbage').expect(400);
      await as(team.owner).get('/notifications?unread=maybe').expect(400);
      await as(team.owner).post('/notifications/read').send({}).expect(400);
      await as(team.owner).post('/notifications/read').send({ ids: [] }).expect(400);
      await as(team.owner)
        .post('/notifications/read')
        .send({ ids: ['nope'] })
        .expect(400);
      await as(team.owner).post('/notifications/read').send({ all: false }).expect(400);
      await as(team.owner)
        .post('/notifications/read')
        .send({ ids: [UNKNOWN_ID], all: true })
        .expect(400);
      await as(team.owner)
        .post('/notifications/read')
        .send({ ids: Array.from({ length: 101 }, () => UNKNOWN_ID) })
        .expect(400);
    });
  });

  describe('threads', () => {
    it('starts a thread, replies, and lists oldest first with author names', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const first = await startThread(team.editor, documentId, 'Why this heading?', 'h1');
      expect(first.warnings).toEqual([]);
      expect(first.thread).toMatchObject({
        documentId,
        blockId: 'h1',
        orphaned: false,
        resolved: false,
        resolvedAt: null,
      });
      expect(first.thread.comments).toHaveLength(1);
      expect(first.thread.comments[0]).toMatchObject({
        body: 'Why this heading?',
        deleted: false,
        editedAt: null,
        author: { id: team.editor.id, name: team.editor.name },
      });
      await reply(team.editor2, first.thread.id, 'Because.');
      const second = await startThread(team.owner, documentId, 'Another', 'p2');

      const threads = await threadsOf(team.viewer, documentId);
      expect(threads.map((t) => t.id)).toEqual([first.thread.id, second.thread.id]);
      expect(threads[0]!.comments.map((c) => c.body)).toEqual(['Why this heading?', 'Because.']);
    });

    it('resolves and reopens, idempotently, and filters by status', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const a = await startThread(team.editor, documentId, 'A', 'a');
      const b = await startThread(team.editor, documentId, 'B', 'b');

      const resolved = await as(team.editor2).post(`/threads/${a.thread.id}/resolve`).expect(200);
      expect(resolved.body).toMatchObject({ id: a.thread.id, resolved: true });
      expect(new Date(resolved.body.resolvedAt).getTime()).not.toBeNaN();
      const again = await as(team.editor).post(`/threads/${a.thread.id}/resolve`).expect(200);
      expect(again.body.resolvedAt).toBe(resolved.body.resolvedAt);

      expect((await threadsOf(team.owner, documentId, '?status=open')).map((t) => t.id)).toEqual([
        b.thread.id,
      ]);
      expect(
        (await threadsOf(team.owner, documentId, '?status=resolved')).map((t) => t.id),
      ).toEqual([a.thread.id]);
      expect(await threadsOf(team.owner, documentId, '?status=all')).toHaveLength(2);
      expect(await threadsOf(team.owner, documentId)).toHaveLength(2);

      const reopened = await as(team.editor).post(`/threads/${a.thread.id}/reopen`).expect(200);
      expect(reopened.body).toMatchObject({ resolved: false, resolvedAt: null });
      await as(team.editor).post(`/threads/${a.thread.id}/reopen`).expect(200);
      expect(await threadsOf(team.owner, documentId, '?status=resolved')).toEqual([]);
    });

    it('flags threads whose block is no longer in the document', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      await setBlocks(documentId, 'keep', 'drop');
      await startThread(team.editor, documentId, 'On the first', 'keep');
      await startThread(team.editor, documentId, 'On the second', 'drop');
      await startThread(team.editor, documentId, 'On a block that never existed', 'nowhere');

      const orphanedBlocks = async () =>
        (await threadsOf(team.viewer, documentId)).filter((t) => t.orphaned).map((t) => t.blockId);
      expect(await orphanedBlocks()).toEqual(['nowhere']);

      await setBlocks(documentId, 'keep');
      expect(await orphanedBlocks()).toEqual(['drop', 'nowhere']);
      await setBlocks(documentId, 'keep', 'drop');
      expect(await orphanedBlocks()).toEqual(['nowhere']);
    });

    it('stores comment text as text: markup is returned as written', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const body = '<img src=x onerror=alert(1)> & <script>alert(2)</script>';
      const { thread } = await startThread(team.editor, documentId, body);
      expect(thread.comments[0]!.body).toBe(body);
      expect((await threadsOf(team.owner, documentId))[0]!.comments[0]!.body).toBe(body);
    });

    it('limits how fast one user can comment', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, 'seed');
      let limited = 0;
      for (let i = 0; i < 32; i += 1) {
        const response = await as(team.editor)
          .post(`/threads/${thread.id}/comments`)
          .send({ body: `n${i}` });
        if (response.status === 429) {
          limited += 1;
          expect(response.body.code).toBe('RATE_LIMITED');
        } else {
          expect(response.status).toBe(201);
        }
      }
      expect(limited).toBeGreaterThan(0);
      // reading is not limited by it, and neither is another user
      await as(team.editor).get(`/documents/${thread.documentId}/threads`).expect(200);
      await as(team.editor2)
        .post(`/threads/${thread.id}/comments`)
        .send({ body: 'still fine' })
        .expect(201);
    });
  });

  describe('editing and deleting', () => {
    it('lets only the author edit, and records when', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, 'Original');
      const commentId = thread.comments[0]!.id;

      await as(team.editor2).patch(`/comments/${commentId}`).send({ body: 'hijack' }).expect(403);
      await as(team.admin).patch(`/comments/${commentId}`).send({ body: 'hijack' }).expect(403);
      await as(team.editor).patch(`/comments/${commentId}`).send({ body: '' }).expect(400);
      const edited = await as(team.editor)
        .patch(`/comments/${commentId}`)
        .send({ body: ' Fixed ' })
        .expect(200);
      expect(edited.body.comment).toMatchObject({ id: commentId, body: 'Fixed' });
      expect(new Date(edited.body.comment.editedAt).getTime()).not.toBeNaN();
      expect((await threadsOf(team.owner, documentId))[0]!.comments[0]!.body).toBe('Fixed');
    });

    it('stops an author who has become a viewer from editing, but not from deleting their own comment', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, 'Mine');
      const commentId = thread.comments[0]!.id;
      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: team.workspaceId, userId: team.editor.id } },
        data: { role: 'VIEWER' },
      });
      await as(team.editor).patch(`/comments/${commentId}`).send({ body: 'x' }).expect(403);
      await as(team.editor).delete(`/comments/${commentId}`).expect(204);
    });

    it('lets the author or an admin delete; others get 403', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, 'Keep me?');
      const reply1 = (await reply(team.editor2, thread.id, 'Second')).comment;
      const reply2 = (await reply(team.editor, thread.id, 'Third')).comment;

      await as(team.editor2).delete(`/comments/${reply2.id}`).expect(403);
      await as(team.viewer).delete(`/comments/${reply2.id}`).expect(403);
      await as(team.editor2).delete(`/comments/${reply1.id}`).expect(204);
      await as(team.admin).delete(`/comments/${reply2.id}`).expect(204);
      await as(team.admin).delete(`/comments/${reply2.id}`).expect(404);

      // the rows stay, blank, so the thread keeps its shape
      const [listed] = await threadsOf(team.viewer, documentId);
      expect(listed!.comments).toHaveLength(3);
      expect(listed!.comments[0]).toMatchObject({ body: 'Keep me?', deleted: false });
      for (const deleted of listed!.comments.slice(1)) {
        expect(deleted).toMatchObject({ body: '', deleted: true, mentions: [] });
      }
      const stored = await prisma.comment.findUniqueOrThrow({ where: { id: reply1.id } });
      expect(stored.body).toBe('');
      expect(stored.deletedAt).not.toBeNull();
      await as(team.editor).patch(`/comments/${reply1.id}`).send({ body: 'x' }).expect(404);
    });

    it('stops listing a thread whose comments are all deleted', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, 'Gone soon');
      await as(team.owner).delete(`/comments/${thread.comments[0]!.id}`).expect(204);

      expect(await threadsOf(team.owner, documentId)).toEqual([]);
      expect(await threadsOf(team.owner, documentId, '?status=open')).toEqual([]);
      await as(team.editor).post(`/threads/${thread.id}/comments`).send({ body: 'x' }).expect(404);
      await as(team.editor).post(`/threads/${thread.id}/resolve`).expect(404);
    });
  });

  describe('mentions', () => {
    it('notifies the people who can view the document, once each, and never the author', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId, 'Roadmap');
      const body = `${mention(team.viewer)} and ${mention(team.editor2)} look; ${mention(team.viewer)} again; I am ${mention(team.editor)}`;
      const { thread, warnings } = await startThread(team.editor, documentId, body);

      expect(warnings).toEqual([]);
      const comment = thread.comments[0]!;
      expect(comment.body).toBe(body);
      expect(comment.mentions).toEqual(
        expect.arrayContaining([
          { userId: team.viewer.id, name: team.viewer.name },
          { userId: team.editor2.id, name: team.editor2.name },
          { userId: team.editor.id, name: team.editor.name },
        ]),
      );
      expect(comment.mentions).toHaveLength(3);

      for (const user of [team.viewer, team.editor2]) {
        const rows = await rowsFor(user.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          type: 'MENTION',
          readAt: null,
          dedupeKey: `comment:${comment.id}:${user.id}`,
        });
        expect(rows[0]!.payload).toMatchObject({
          workspaceId: team.workspaceId,
          documentId,
          documentTitle: 'Roadmap',
          threadId: thread.id,
          commentId: comment.id,
          actor: { id: team.editor.id, name: team.editor.name },
        });
      }
      expect(await rowsFor(team.editor.id)).toEqual([]);
      expect(await rowsFor(team.owner.id)).toEqual([]);

      const metrics = await http$()
        .get('/metrics')
        .set('Authorization', `Bearer ${process.env.METRICS_TOKEN}`)
        .expect(200);
      expect(metrics.text).toMatch(/notifications_created_total\{type="MENTION"\} [1-9]/);
    });

    it('ignores a mention of someone who cannot view the document, and says so', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      await as(team.owner)
        .patch(`/documents/${documentId}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      const stranger = `@[${UNKNOWN_ID}]`;
      const body = `ok ${mention(team.owner)} no ${mention(team.outsider)} no ${mention(team.editor2)} no ${stranger} end`;

      const { thread, warnings } = await startThread(team.owner, documentId, body);
      expect(warnings).toEqual(
        expect.arrayContaining([
          { code: 'MENTION_IGNORED', userId: team.outsider.id },
          { code: 'MENTION_IGNORED', userId: team.editor2.id },
          { code: 'MENTION_IGNORED', userId: UNKNOWN_ID },
        ]),
      );
      expect(warnings).toHaveLength(3);
      // the refused tokens are gone, so a client never shows a raw id
      expect(thread.comments[0]!.body).toBe(`ok ${mention(team.owner)} no  no  no  end`);
      expect(thread.comments[0]!.mentions.map((m) => m.userId)).toEqual([team.owner.id]);
      for (const user of [team.outsider, team.editor2]) expect(await rowsFor(user.id)).toEqual([]);

      // a share makes the person mentionable
      await shareWith(team.owner, documentId, team.outsider, 'VIEWER');
      const later = await reply(team.owner, thread.id, `now ${mention(team.outsider)}`);
      expect(later.warnings).toEqual([]);
      expect(await rowsFor(team.outsider.id)).toHaveLength(1);
    });

    it('treats other @ text as text, and caps the number of mentions', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread, warnings } = await startThread(
        team.editor,
        documentId,
        `@everyone @[not-an-id] @${team.viewer.id} ${mention(team.viewer)}`,
      );
      expect(warnings).toEqual([]);
      expect(thread.comments[0]!.mentions).toHaveLength(1);
      expect(await rowsFor(team.viewer.id)).toHaveLength(1);

      const crowd = Array.from(
        { length: 22 },
        (_, i) => `@[0198d6c0-0000-7000-8000-${String(i + 1).padStart(12, '0')}]`,
      );
      const crowded = await startThread(team.editor, documentId, `hi ${crowd.join(' ')}`, 'b2');
      expect(crowded.warnings.filter((w) => w.code === 'MENTION_LIMIT')).toHaveLength(2);
      expect(crowded.warnings.filter((w) => w.code === 'MENTION_IGNORED')).toHaveLength(20);
    });

    it('does not notify again when a comment is saved again or a request is retried', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, `hi ${mention(team.viewer)}`);
      const commentId = thread.comments[0]!.id;
      expect(await rowsFor(team.viewer.id)).toHaveLength(1);
      const [original] = await rowsFor(team.viewer.id);
      await as(team.viewer).post('/notifications/read').send({ all: true }).expect(200);

      // the same mention in an edit: nothing new, and what was read stays read
      await as(team.editor)
        .patch(`/comments/${commentId}`)
        .send({ body: `hi again ${mention(team.viewer)}` })
        .expect(200);
      const rows = await rowsFor(team.viewer.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(original!.id);
      expect(rows[0]!.readAt).not.toBeNull();
      // ... but the excerpt follows the text
      expect(rows[0]!.payload).toMatchObject({ excerpt: expect.stringContaining('hi again') });

      // a redelivered or concurrent write of the same notification creates nothing
      const again = await prisma.$transaction((tx) =>
        notifications.syncMentions(tx, {
          commentId,
          recipientIds: [team.viewer.id],
          payload: original!.payload as never,
        }),
      );
      expect(again).toEqual([]);
      expect(await rowsFor(team.viewer.id)).toHaveLength(1);
    });

    it('notifies a user added by an edit, and withdraws the notification of one removed', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, `one ${mention(team.viewer)}`);
      const commentId = thread.comments[0]!.id;

      const edited = await as(team.editor)
        .patch(`/comments/${commentId}`)
        .send({ body: `two ${mention(team.editor2)}` })
        .expect(200);
      expect(edited.body.comment.mentions.map((m: { userId: string }) => m.userId)).toEqual([
        team.editor2.id,
      ]);
      expect(await rowsFor(team.viewer.id)).toEqual([]);
      expect(await rowsFor(team.editor2.id)).toHaveLength(1);
    });

    it('lists the people who can be mentioned', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const list = async (user: TestUser, q = '') =>
        (
          await as(user)
            .get(`/documents/${documentId}/mentionable?q=${encodeURIComponent(q)}`)
            .expect(200)
        ).body as MentionableUser[];

      const everyone = await list(team.editor);
      expect(everyone.map((u) => u.id).sort()).toEqual(
        [team.owner, team.admin, team.editor, team.editor2, team.viewer].map((u) => u.id).sort(),
      );
      expect(everyone[0]).toEqual({
        id: expect.any(String),
        name: expect.any(String),
        email: expect.any(String),
      });

      expect((await list(team.editor, 'viewer')).map((u) => u.id)).toEqual([team.viewer.id]);
      expect((await list(team.editor, 'VIEWER')).map((u) => u.id)).toEqual([team.viewer.id]);
      expect((await list(team.editor, team.admin.email.slice(0, 12))).map((u) => u.id)).toEqual([
        team.admin.id,
      ]);
      expect(await list(team.editor, 'nobody-has-this-name')).toEqual([]);
      // LIKE wildcards are text
      expect(await list(team.editor, '%')).toEqual([]);
      expect(await list(team.editor, '_')).toEqual([]);

      // restricted: only the admins and people with a share
      await as(team.owner)
        .patch(`/documents/${documentId}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      await shareWith(team.owner, documentId, team.guest, 'EDITOR');
      expect((await list(team.owner)).map((u) => u.id).sort()).toEqual(
        [team.owner, team.admin, team.guest].map((u) => u.id).sort(),
      );
    });
  });

  describe('notifications', () => {
    it('lists newest first with a cursor, counts the unread, and marks as read', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId, 'Handbook');
      const bodies = ['first', 'second', 'third', 'fourth', 'fifth'];
      for (const [i, text] of bodies.entries()) {
        await startThread(team.editor, documentId, `${text} ${mention(team.viewer)}`, `b${i}`);
      }
      expect(await unreadOf(team.viewer)).toBe(5);

      const page1 = await notificationsOf(team.viewer, '?limit=2');
      expect(page1.items.map((n) => n.payload.excerpt)).toEqual([
        expect.stringContaining('fifth'),
        expect.stringContaining('fourth'),
      ]);
      expect(page1.items[0]).toMatchObject({
        type: 'MENTION',
        read: false,
        payload: { documentTitle: 'Handbook', actor: { name: team.editor.name } },
      });
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = await notificationsOf(team.viewer, `?limit=2&cursor=${page1.nextCursor}`);
      expect(page2.items.map((n) => n.payload.excerpt)).toEqual([
        expect.stringContaining('third'),
        expect.stringContaining('second'),
      ]);
      const page3 = await notificationsOf(team.viewer, `?limit=2&cursor=${page2.nextCursor}`);
      expect(page3.items.map((n) => n.payload.excerpt)).toEqual([expect.stringContaining('first')]);
      expect(page3.nextCursor).toBeNull();

      const marked = await as(team.viewer)
        .post('/notifications/read')
        .send({ ids: [page1.items[0]!.id, page1.items[1]!.id, page1.items[0]!.id] })
        .expect(200);
      expect(marked.body).toEqual({ updated: 2 });
      expect(await unreadOf(team.viewer)).toBe(3);
      expect((await notificationsOf(team.viewer, '?unread=true')).items).toHaveLength(3);
      expect((await notificationsOf(team.viewer)).items.filter((n) => n.read)).toHaveLength(2);
      // marking again changes nothing
      expect(
        (
          await as(team.viewer)
            .post('/notifications/read')
            .send({ ids: [page1.items[0]!.id] })
            .expect(200)
        ).body,
      ).toEqual({ updated: 0 });

      expect(
        (await as(team.viewer).post('/notifications/read').send({ all: true }).expect(200)).body,
      ).toEqual({
        updated: 3,
      });
      expect(await unreadOf(team.viewer)).toBe(0);
      expect((await notificationsOf(team.viewer, '?unread=true')).items).toEqual([]);
    });

    it("never shows or changes another user's notifications", async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      await startThread(team.editor, documentId, `psst ${mention(team.viewer)}`);
      const [theirs] = await rowsFor(team.viewer.id);

      expect((await notificationsOf(team.editor)).items).toEqual([]);
      expect(await unreadOf(team.editor)).toBe(0);
      const attempt = await as(team.editor)
        .post('/notifications/read')
        .send({ ids: [theirs!.id] })
        .expect(200);
      expect(attempt.body).toEqual({ updated: 0 });
      expect(
        (await prisma.notification.findUniqueOrThrow({ where: { id: theirs!.id } })).readAt,
      ).toBeNull();
      await as(team.editor).post('/notifications/read').send({ all: true }).expect(200);
      expect(await unreadOf(team.viewer)).toBe(1);
    });

    it('collects notifications from every workspace', async () => {
      const first = await setup();
      const second = await setup();
      await prisma.workspaceMember.create({
        data: { workspaceId: second.workspaceId, userId: first.viewer.id, role: 'VIEWER' },
      });
      const docA = await createDocument(first.owner, first.workspaceId, 'In A');
      const docB = await createDocument(second.owner, second.workspaceId, 'In B');
      await startThread(first.editor, docA, `a ${mention(first.viewer)}`);
      await startThread(second.editor, docB, `b ${mention(first.viewer)}`);

      const page = await notificationsOf(first.viewer);
      expect(page.items.map((n) => n.payload.documentTitle)).toEqual(['In B', 'In A']);
      expect(await unreadOf(first.viewer)).toBe(2);
    });

    it('stops showing a notification once the document cannot be opened any more', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId, 'Confidential');
      await startThread(team.editor, documentId, `secret ${mention(team.editor2)}`);
      expect(await unreadOf(team.editor2)).toBe(1);

      await as(team.owner)
        .patch(`/documents/${documentId}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      expect(await unreadOf(team.editor2)).toBe(0);
      expect((await notificationsOf(team.editor2)).items).toEqual([]);

      await shareWith(team.owner, documentId, team.editor2, 'VIEWER');
      expect(await unreadOf(team.editor2)).toBe(1);
      expect((await notificationsOf(team.editor2)).items).toHaveLength(1);

      await as(team.owner).delete(`/documents/${documentId}`).expect(204);
      expect(await unreadOf(team.editor2)).toBe(0);
      await as(team.owner).post(`/documents/${documentId}/restore`).expect(200);
      expect(await unreadOf(team.editor2)).toBe(1);
    });

    it('keeps a mention visible to the editor who wrote the document after it is restricted', async () => {
      const team = await setup();
      const documentId = await createDocument(team.editor, team.workspaceId, 'Authored');
      await startThread(team.owner, documentId, `hello ${mention(team.editor)}`);
      expect(await unreadOf(team.editor)).toBe(1);

      await as(team.editor)
        .patch(`/documents/${documentId}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      expect(await unreadOf(team.editor)).toBe(1);
      expect((await notificationsOf(team.editor)).items).toHaveLength(1);
    });

    it('removes the notifications of a deleted comment', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, `oops ${mention(team.viewer)}`);
      expect(await unreadOf(team.viewer)).toBe(1);
      await as(team.editor).delete(`/comments/${thread.comments[0]!.id}`).expect(204);
      expect(await rowsFor(team.viewer.id)).toEqual([]);
      expect(await unreadOf(team.viewer)).toBe(0);
    });
  });

  describe('live events', () => {
    interface Stream {
      statusCode: number;
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
        .filter((block) => block.includes('event: notification.created'))
        .map((block) =>
          JSON.parse(
            block
              .split('\n')
              .find((l) => l.startsWith('data: '))!
              .slice(6),
          ),
        );

    it('delivers notification.created to the person mentioned only, on any workspace they have open', async () => {
      const first = await setup();
      const second = await setup();
      await prisma.workspaceMember.create({
        data: { workspaceId: second.workspaceId, userId: first.viewer.id, role: 'VIEWER' },
      });
      const documentId = await createDocument(first.owner, first.workspaceId);

      const onFirst = await openStream(first.viewer, first.workspaceId);
      const onSecond = await openStream(first.viewer, second.workspaceId);
      const bystander = await openStream(first.editor2, first.workspaceId);
      const author = await openStream(first.editor, first.workspaceId);
      const otherTeam = await openStream(second.owner, second.workspaceId);
      try {
        expect(onFirst.statusCode).toBe(200);
        await startThread(first.editor, documentId, `look ${mention(first.viewer)}`);
        const [row] = await rowsFor(first.viewer.id);
        await until(() => eventsOf(onFirst).length === 1 && eventsOf(onSecond).length === 1);
        await wait(200);

        expect(eventsOf(onFirst)).toEqual([
          { type: 'notification.created', notificationId: row!.id },
        ]);
        expect(eventsOf(onSecond)).toEqual(eventsOf(onFirst));
        for (const stream of [bystander, author, otherTeam]) expect(eventsOf(stream)).toEqual([]);
      } finally {
        for (const stream of [onFirst, onSecond, bystander, author, otherTeam]) stream.close();
      }
    });
  });

  describe('email', () => {
    const emailsTo = (to: string) => sent.filter((message) => message.to === to);

    it('sends one escaped email per notification, with a link to the document', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId, '<b>Q4</b> plan');
      await startThread(
        team.editor,
        documentId,
        `<img src=x onerror=alert(1)> ${mention(team.viewer)} & co`,
        'blk',
      );
      await until(() => emailsTo(team.viewer.email).length === 1);
      await wait(200);

      const [message] = emailsTo(team.viewer.email);
      expect(emailsTo(team.viewer.email)).toHaveLength(1);
      expect(message!.subject).toBe(`${team.editor.name} mentioned you in <b>Q4</b> plan`);
      expect(message!.html).not.toMatch(/<img|<b>/);
      expect(message!.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(message!.html).toContain(`@${team.viewer.name}`);
      expect(message!.text).toContain('<img src=x onerror=alert(1)>');
      const thread = await prisma.commentThread.findFirstOrThrow({ where: { documentId } });
      const link = `http://localhost:3000/w/${team.workspaceId}/d/${documentId}?thread=${thread.id}`;
      expect(message!.text).toContain(link);
      expect(message!.html).toContain(link);
    });

    it('sends nothing to the author or to people who were not mentioned', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId);
      await startThread(
        team.editor,
        documentId,
        `me ${mention(team.editor)} and ${mention(team.outsider)}`,
      );
      await wait(500);
      for (const user of [team.editor, team.outsider, team.owner]) {
        expect(emailsTo(user.email)).toEqual([]);
      }
    });

    it('does not send for a notification that is gone, or when the recipient lost access meanwhile', async () => {
      const team = await setup();
      const mentions = app.get(MentionMailService, { strict: false });
      expect(await mentions.deliver(UNKNOWN_ID)).toBe('skipped');

      const documentId = await createDocument(team.owner, team.workspaceId);
      const { thread } = await startThread(team.editor, documentId, `hi ${mention(team.viewer)}`);
      await until(() => emailsTo(team.viewer.email).length === 1);
      const before = sent.length;

      await as(team.owner)
        .patch(`/documents/${documentId}`)
        .send({ visibility: 'RESTRICTED' })
        .expect(200);
      const [row] = await rowsFor(team.viewer.id);
      expect(await mentions.deliver(row!.id)).toBe('skipped');
      await as(team.owner).delete(`/comments/${thread.comments[0]!.id}`).expect(204);
      expect(await mentions.deliver(row!.id)).toBe('skipped');
      expect(sent.length).toBe(before);
    });

    it('queues one job per notification however often it is enqueued', async () => {
      const queues = app.get(QueueService);
      const mailQueue = app.get(MailQueueService, { strict: false });
      const id = `0198d6c0-0000-7000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`;
      await mailQueue.sendMention({ notificationId: id });
      await mailQueue.sendMention({ notificationId: id });
      const jobs = (
        await queues
          .getQueue(QUEUE_NAMES.mail)
          .getJobs(['waiting', 'delayed', 'active', 'completed', 'failed'])
      ).filter((job) => job.data.notificationId === id);
      expect(jobs).toHaveLength(1);
    });

    itWithMailpit('delivers the mention email to Mailpit', async () => {
      const team = await setup();
      const documentId = await createDocument(team.owner, team.workspaceId, 'Mailpit check');
      await startThread(team.editor, documentId, `ping ${mention(team.viewer)}`);

      const deadline = Date.now() + 15_000;
      let message: { ID: string } | undefined;
      while (!message && Date.now() < deadline) {
        const search = await fetch(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${team.viewer.email}`)}`,
        );
        const body = (await search.json()) as { messages: Array<{ ID: string }> };
        message = body.messages[0];
        if (!message) await wait(200);
      }
      if (!message) throw new Error('mention email did not reach Mailpit');
      const detail = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`)
      ).json()) as {
        Subject: string;
        Text: string;
      };
      expect(detail.Subject).toBe(`${team.editor.name} mentioned you in Mailpit check`);
      expect(detail.Text).toContain(`@${team.viewer.name}`);
    });
  });
});
