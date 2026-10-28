import './test/persistence-env';
import './test/setup-env';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  DocumentStateReader,
  DocumentStateWriter,
  DocumentVersions,
  type PrismaClient,
} from '@collab-docs/db';
import {
  COLLAB_CLOSE,
  PERM_EVENT_CHANNELS,
  stateVectorCovers,
  base64ToBytes,
} from '@collab-docs/shared';
import { COLLAB_INTERNAL } from '@collab-docs/shared';
import { parseConfig, QUEUE_NAMES, QueueService, REDIS_CLIENT } from '@collab-docs/nest';
import type { Redis } from 'ioredis';
import { DOCUMENT_STORE, type DocumentStore } from './rooms/document-store';
import type { PostgresDocumentStore } from './rooms/postgres-document-store';
import { RoomManager } from './rooms/room-manager';
import { type RunningCollab, startCollab } from './test/collab-app';
import { Client, makeTeam, settle, ticketFor, waitFor } from './test/collab-fixtures';
import { PrismaService } from './prisma/prisma.service';

const IDLE_MS = parseConfig(process.env).COLLAB_ROOM_IDLE_MS;

describe('document persistence', () => {
  let collab: RunningCollab;
  let prisma: PrismaClient;
  let reader: DocumentStateReader;
  let versions: DocumentVersions;
  let store: DocumentStore;
  let rooms: RoomManager;
  let queues: QueueService;
  let redis: Redis;
  const clients: Client[] = [];

  async function connect(
    user: { id: string },
    documentId: string,
    url = collab.wsUrl,
  ): Promise<Client> {
    const client = new Client(url, documentId, await ticketFor(user, documentId));
    clients.push(client);
    return client;
  }

  async function bind(): Promise<void> {
    prisma = collab.app.get(PrismaService);
    reader = collab.app.get(DocumentStateReader);
    versions = collab.app.get(DocumentVersions);
    store = collab.app.get(DOCUMENT_STORE);
    rooms = collab.app.get(RoomManager);
    queues = collab.app.get(QueueService);
    redis = collab.app.get(REDIS_CLIENT);
  }

  const internal = (
    action: keyof typeof COLLAB_INTERNAL,
    payload: Record<string, unknown> = {},
    options?: { token?: string | null },
  ) => collab.send(COLLAB_INTERNAL[action], payload, options);

  const content = async (documentId: string): Promise<string> => {
    const doc = await reader.readDoc(documentId);
    const text = doc.getXmlFragment('content').toString();
    doc.destroy();
    return text;
  };

  const revisionOf = async (documentId: string): Promise<number> =>
    Number((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).revision);

  const rowsOf = (documentId: string) => prisma.documentUpdate.count({ where: { documentId } });

  beforeAll(async () => {
    collab = await startCollab();
    await bind();
    await collab.app.get<Redis>(REDIS_CLIENT).flushdb();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clients.splice(0).forEach((client) => client.destroy());
  });

  afterAll(async () => {
    await collab.stop();
  });

  describe('durability', () => {
    it('keeps nothing in the database until a flush, then everything that was typed', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'buffered');
      await waitFor(() => store.constructor.name === 'PostgresDocumentStore', 'store');
      await settle(200);
      expect(await content(documentId)).toBe('');

      const response = await internal('flush', { documentId: documentId });
      expect(response.status).toBe(200);
      expect(await content(documentId)).toContain('buffered');
      expect((response.body as { revision: number }).revision).toBe(await revisionOf(documentId));
      expect(await revisionOf(documentId)).toBeGreaterThan(0);
    });

    it('stores a deletion and says so, though the state vector cannot show it', async () => {
      const { editor, owner, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'delete me');
      await internal('flush', { documentId: documentId });
      expect(await content(documentId)).toContain('delete me');

      const rows = await rowsOf(documentId);
      const vector = Y.encodeStateVector(client.doc);
      client.paragraph().delete(0, 'delete me'.length);
      await settle(50);
      expect(Y.encodeStateVector(client.doc)).toEqual(vector);
      expect(await content(documentId)).toContain('delete me');

      const late = await connect(owner, documentId);
      await waitFor(() => late.synced, 'the late client to sync');
      // the handshake reports what is durable, not what this connection holds; no event has acknowledged the deletion
      expect(late.event('persisted')).toBeDefined();
      expect(late.event('persisted')).not.toHaveProperty('saved');

      await internal('flush', { documentId: documentId });
      await waitFor(() => late.event('persisted')?.saved === true, 'the deletion to be saved');
      expect(await content(documentId)).not.toContain('delete me');
      expect(await rowsOf(documentId)).toBe(rows + 1);
    });

    it('reports "persisted" only after the content is in the database and covers the client', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'acknowledged');
      const before = client.events.filter((e) => e.type === 'persisted').length;
      await settle(150);
      expect(client.events.filter((e) => e.type === 'persisted')).toHaveLength(before);
      expect(await content(documentId)).toBe('');

      await internal('flush', { documentId: documentId });
      await waitFor(() => {
        const persisted = client.event('persisted');
        return (
          !!persisted &&
          stateVectorCovers(base64ToBytes(persisted.sv), Y.encodeStateVector(client.doc))
        );
      }, 'a persisted event covering the local state');
      expect(await content(documentId)).toContain('acknowledged');
    });

    it('keeps reporting a covering "persisted" while the client keeps typing', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      for (const word of ['first', ' second', ' third']) {
        client.paragraph().insert(client.paragraph().length, word);
        await internal('flush', { documentId: documentId });
        await waitFor(() => {
          const persisted = client.event('persisted');
          return (
            !!persisted &&
            stateVectorCovers(base64ToBytes(persisted.sv), Y.encodeStateVector(client.doc))
          );
        }, `a persisted event covering "${word}"`);
      }
      expect(await content(documentId)).toContain('first second third');
    });

    it('writes a closing room and a shutting down service without waiting for the timers', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const first = await connect(editor, documentId);
      await waitFor(() => first.synced, 'sync');
      first.paragraph().insert(0, 'survives the restart');
      await settle(100);
      expect(await content(documentId)).toBe('');

      first.destroy();
      await collab.stop(); // SIGTERM path: the final flush runs before the connections are closed

      collab = await startCollab();
      await bind();
      expect(await rowsOf(documentId)).toBe(0); // compacted by the release: state, no tail
      const second = await connect(editor, documentId);
      await waitFor(
        () => second.text() === 'survives the restart',
        'the content after the restart',
      );
      expect(await prisma.documentState.count({ where: { documentId } })).toBe(1);
    });

    it('writes when an idle room is unloaded', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'on unload');
      await settle(100);
      client.destroy();
      await waitFor(
        async () => (await content(documentId)).includes('on unload'),
        'the unloading room to write its updates',
      );
    });

    it('keeps the unwritten updates when the database refuses the write, and writes them later', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'not lost');

      const append = jest
        .spyOn(DocumentStateWriter.prototype, 'append')
        .mockRejectedValueOnce(new Error('connection reset'));
      const failed = await internal('flush', { documentId: documentId });
      expect(failed.status).toBe(500);
      expect(append).toHaveBeenCalledTimes(1);
      expect(await content(documentId)).toBe('');

      client.paragraph().insert(0, 'and more ');
      const retried = await internal('flush', { documentId: documentId });
      expect(retried.status).toBe(200);
      const stored = await content(documentId);
      expect(stored).toContain('not lost');
      expect(stored).toContain('and more');
    });

    it('does not lose a duplicate-free log when the same update is delivered twice', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'once');
      await internal('flush', { documentId: documentId });
      const rows = await rowsOf(documentId);
      const stored = await prisma.documentUpdate.findFirstOrThrow({ where: { documentId } });
      const writer = new DocumentStateWriter(prisma);
      await writer.append(documentId, new Uint8Array(stored.update));
      expect(await rowsOf(documentId)).toBe(rows);
    });
  });

  describe('cold start', () => {
    it('loads state and tail, and survives a damaged tail row', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const source = new Y.Doc();
      const text = new Y.XmlText();
      source.getXmlFragment('content').insert(0, [text]);
      text.insert(0, 'from the log');
      const writer = new DocumentStateWriter(prisma);
      await writer.append(documentId, Y.encodeStateAsUpdate(source));
      await prisma.documentUpdate.create({
        data: { documentId, update: Buffer.from([255, 255, 9, 9, 9]), updateHash: 'broken-row' },
      });

      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      expect(client.doc.getXmlFragment('content').toString()).toContain('from the log');
      const metrics = await (
        await fetch(`${collab.httpUrl}/metrics`, {
          headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` },
        })
      ).text();
      expect(metrics).toMatch(/collab_bad_log_rows_total [1-9]/);

      // the room keeps working
      client.doc.getXmlFragment('content').insert(1, [new Y.XmlText('more')]);
      await internal('flush', { documentId: documentId });
      expect(await content(documentId)).toContain('more');
    });
  });

  describe('derived data', () => {
    it('bumps the revision and queues document.changed for search and publishing after a flush', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'a');
      await internal('flush', { documentId: documentId });
      const first = await revisionOf(documentId);
      client.paragraph().insert(1, 'b');
      await internal('flush', { documentId: documentId });
      expect(await revisionOf(documentId)).toBe(first + 1);

      const jobs = async (queue: string) =>
        (await queues.getQueue(queue).getJobs(['delayed', 'waiting', 'active'])).filter(
          (job) => job?.data?.documentId === documentId,
        );
      await waitFor(async () => (await jobs(QUEUE_NAMES.searchSync)).length > 0, 'search-sync job');
      await waitFor(
        async () => (await jobs(QUEUE_NAMES.publicRevalidate)).length > 0,
        'revalidate job',
      );
      const [job] = await jobs(QUEUE_NAMES.searchSync);
      expect(job?.data).toMatchObject({ reason: 'content', revision: expect.any(Number) });
    });

    it('still writes the content when the queue is unavailable', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      jest.spyOn(queues, 'getQueue').mockImplementation(() => {
        throw new Error('redis is down');
      });
      client.paragraph().insert(0, 'despite redis');
      const response = await internal('flush', { documentId: documentId });
      expect(response.status).toBe(200);
      expect(await content(documentId)).toContain('despite redis');
      expect(await revisionOf(documentId)).toBeGreaterThan(0);
    });
  });

  describe('deleting a document while it is edited', () => {
    it('writes the last changes, tells the clients and closes with 4410 (Redis event)', async () => {
      const { editor, owner, workspace, documentId } = await makeTeam(prisma);
      const a = await connect(editor, documentId);
      const b = await connect(owner, documentId);
      await waitFor(() => a.synced && b.synced, 'sync');
      a.paragraph().insert(0, 'last words');
      await waitFor(() => b.text() === 'last words', 'delivery');
      expect(await content(documentId)).toBe('');

      await prisma.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
      await redis.publish(
        PERM_EVENT_CHANNELS.docDeleted,
        JSON.stringify({ workspaceId: workspace.id, documentIds: [documentId] }),
      );
      await waitFor(
        () => a.closes.includes(COLLAB_CLOSE.deleted) && b.closes.includes(COLLAB_CLOSE.deleted),
        'both sockets to close with 4410',
      );
      expect(a.event('deleted')).toEqual({ type: 'deleted' });
      // The access re-check can close the sockets (4410) just before the event is handled, so the text is
      // guaranteed to reach the database, not to be there at the instant the last socket closes.
      await waitFor(
        async () => (await content(documentId)).includes('last words'),
        'the last words to reach the database',
      );
    });

    it('does the same through the internal close endpoint, and is idempotent', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'final');
      await waitFor(() => client.event('persisted') !== undefined, 'connected');

      const first = await internal('close', { documentId: documentId });
      expect(first.body).toEqual({ closed: true });
      await waitFor(() => client.closes.includes(COLLAB_CLOSE.deleted), 'the 4410 close');
      expect(await content(documentId)).toContain('final');
      const second = await internal('close', { documentId: documentId });
      expect(second.body).toEqual({ closed: false });
    });
  });

  describe('restoring a version', () => {
    async function twoVersionsOfOneDocument() {
      const team = await makeTeam(prisma);
      const a = await connect(team.editor, team.documentId);
      const b = await connect(team.owner, team.documentId);
      await waitFor(() => a.synced && b.synced, 'sync');
      a.paragraph().insert(0, 'version one');
      await waitFor(() => b.text() === 'version one', 'delivery');
      await internal('flush', { documentId: team.documentId });
      const snapshot = await versions.create({
        documentId: team.documentId,
        kind: 'MANUAL',
        label: 'first',
        createdBy: team.editor.id,
      });
      b.paragraph().insert(b.text().length, ' and then version two');
      await waitFor(() => a.text() === 'version one and then version two', 'delivery of v2');
      return { ...team, a, b, snapshot };
    }

    it('converges every client on the old content, snapshotting the current one first', async () => {
      const { documentId, a, b, snapshot, editor } = await twoVersionsOfOneDocument();
      const before = await revisionOf(documentId);

      const response = await internal('restore', {
        documentId: documentId,
        versionId: snapshot.id,
        userId: editor.id,
      });
      expect(response.status).toBe(200);
      const { revision } = response.body as { revision: number };
      expect(revision).toBeGreaterThan(before);

      await waitFor(
        () => a.text() === 'version one' && b.text() === 'version one',
        'clients to converge',
      );
      expect(await content(documentId)).toContain('version one');
      expect(await content(documentId)).not.toContain('version two');

      const [safety] = await prisma.documentVersion.findMany({
        where: { documentId, kind: 'PRE_RESTORE' },
      });
      expect(safety).toMatchObject({ createdBy: editor.id });
      const old = await versions.readDoc(documentId, safety!.id);
      expect(old!.getXmlFragment('content').toString()).toContain('version two');
    });

    it('keeps working afterwards: edits after the restore merge as usual', async () => {
      const { documentId, a, b, snapshot, editor } = await twoVersionsOfOneDocument();
      await internal('restore', {
        documentId: documentId,
        versionId: snapshot.id,
        userId: editor.id,
      });
      await waitFor(() => a.text() === 'version one' && b.text() === 'version one', 'converge');
      a.paragraph().insert(0, '>> ');
      await waitFor(() => b.text() === '>> version one', 'edit after restore');
      await internal('flush', { documentId: documentId });
      expect(await content(documentId)).toContain('>> version one');
    });

    it('restores a document nobody has open', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const source = new Y.Doc();
      const element = new Y.XmlElement('paragraph');
      element.insert(0, [new Y.XmlText('old text')]);
      source.getXmlFragment('content').insert(0, [element]);
      const writer = new DocumentStateWriter(prisma);
      await writer.append(documentId, Y.encodeStateAsUpdate(source));
      const snapshot = await versions.create({ documentId, kind: 'MANUAL' });
      (element.get(0) as Y.XmlText).insert(0, 'NEW ');
      await writer.append(documentId, Y.encodeStateAsUpdate(source));
      expect(await content(documentId)).toContain('NEW old text');

      const response = await internal('restore', {
        documentId: documentId,
        versionId: snapshot.id,
        userId: editor.id,
      });
      expect(response.status).toBe(200);
      const restored = await content(documentId);
      expect(restored).toContain('old text');
      expect(restored).not.toContain('NEW');
      expect(
        await prisma.documentVersion.count({ where: { documentId, kind: 'PRE_RESTORE' } }),
      ).toBe(1);
      await waitFor(
        async () => (await rooms.find(documentId)) === undefined,
        'the temporary room to unload',
      );
    });

    it('writes the restored content even when the last client leaves mid-restore', async () => {
      const { editor, documentId } = await makeTeam(prisma);
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      const room = await rooms.find(documentId);
      expect(room).toBeDefined();
      client.paragraph().insert(0, 'version one');
      await internal('flush', { documentId });
      const snapshot = await versions.create({ documentId, kind: 'MANUAL', label: 'first' });

      client.paragraph().insert(client.paragraph().length, ' and then version two');
      await waitFor(
        () => (store as PostgresDocumentStore).pendingCount(documentId) > 0,
        'the server to buffer the second edit',
      );

      const realFlush = store.flush.bind(store);
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => (releaseGate = resolve));
      let firstFlushReached!: () => void;
      const reached = new Promise<void>((resolve) => (firstFlushReached = resolve));
      let gated = false;
      jest.spyOn(store, 'flush').mockImplementation(async (id: string) => {
        if (!gated) {
          gated = true;
          firstFlushReached();
          await gate;
        }
        return realFlush(id);
      });

      const responsePromise = internal('restore', {
        documentId,
        versionId: snapshot.id,
        userId: editor.id,
      });
      await reached;
      client.destroy();
      await waitFor(() => room?.size === 0, 'the last client to leave');
      // the room is empty now but the restore still holds the document: an idle unload must not take it away
      await settle(IDLE_MS * 2);
      releaseGate();

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(await content(documentId)).toContain('version one');
      expect(await content(documentId)).not.toContain('version two');

      const safety = await prisma.documentVersion.findFirstOrThrow({
        where: { documentId, kind: 'PRE_RESTORE' },
      });
      const before = await versions.readDoc(documentId, safety.id);
      expect(before?.getXmlFragment('content').toString()).toContain('version two');
      before?.destroy();
    });

    it('answers 404 for a version of another document and 400 for a malformed request', async () => {
      const first = await makeTeam(prisma);
      const second = await makeTeam(prisma);
      const foreign = await versions.create({ documentId: second.documentId, kind: 'MANUAL' });
      const missing = await internal('restore', {
        documentId: first.documentId,
        versionId: foreign.id,
        userId: first.editor.id,
      });
      expect(missing.status).toBe(404);
      const unknown = await internal('restore', {
        documentId: first.documentId,
        versionId: randomUUID(),
        userId: first.editor.id,
      });
      expect(unknown.status).toBe(404);
      const malformed = await internal('restore', {
        documentId: first.documentId,
        versionId: 'nope',
      });
      expect(malformed.status).toBe(400);
    });
  });

  describe('internal API', () => {
    it('requires the token on every endpoint', async () => {
      const id = randomUUID();
      for (const action of ['flush', 'restore', 'close'] as const) {
        const payload = { documentId: id };
        expect((await internal(action, payload, { token: null })).status).toBe(401);
        expect((await internal(action, payload, { token: 'wrong' })).status).toBe(401);
      }
    });

    it('answers 404 when flushing an unknown document and 400 for a malformed id', async () => {
      const unknown = await internal('flush', {
        documentId: randomUUID(),
        correlationId: 'corr-from-the-api-0001',
      });
      expect(unknown.status).toBe(404);
      // the error carries the id of the request that caused it, as an HTTP error would
      expect(unknown.body).toMatchObject({
        code: 'NOT_FOUND',
        correlationId: 'corr-from-the-api-0001',
      });
      expect((await internal('flush', { documentId: 'not-a-uuid' })).status).toBe(400);
    });
  });
});
