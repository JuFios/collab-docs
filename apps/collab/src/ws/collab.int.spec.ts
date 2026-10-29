import '../test/setup-env';
import { randomBytes, randomUUID } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { DocumentStateReader, DocumentStateWriter, type PrismaClient } from '@collab-docs/db';
import {
  COLLAB_CLOSE,
  COLLAB_INTERNAL,
  COLLAB_MESSAGE,
  type CollabRoomEvent,
  PERM_EVENT_CHANNELS,
} from '@collab-docs/shared';
import { REDIS_CLIENT, parseConfig, signCollabTicket } from '@collab-docs/nest';
import type { Redis } from 'ioredis';
import { RoomManager } from '../rooms/room-manager';
import { type RunningCollab, startCollab } from '../test/collab-app';
import { PrismaService } from '../prisma/prisma.service';

const SECRET = parseConfig(process.env).COLLAB_TICKET_SECRET;
const IDLE_MS = parseConfig(process.env).COLLAB_ROOM_IDLE_MS;
const RECHECK_MS = parseConfig(process.env).COLLAB_ACCESS_RECHECK_MS;

interface TestUser {
  id: string;
}

/** A y-websocket client the way the editor will use it, with the room events and close codes recorded. */
class Client {
  readonly doc = new Y.Doc();
  readonly events: CollabRoomEvent[] = [];
  readonly closes: number[] = [];
  readonly provider: WebsocketProvider;

  constructor(wsUrl: string, documentId: string, ticket: string) {
    this.provider = new WebsocketProvider(wsUrl, documentId, this.doc, {
      WebSocketPolyfill: WebSocket as never,
      params: { ticket },
      disableBc: true,
      maxBackoffTime: 100,
    });
    this.provider.messageHandlers[COLLAB_MESSAGE.roomEvent] = (_encoder, decoder) => {
      this.events.push(JSON.parse(decoding.readVarString(decoder)) as CollabRoomEvent);
    };
    this.provider.on('connection-close', (event: { code: number } | null) => {
      if (event) {
        this.closes.push(event.code);
        // as the real client does: reconnecting after these codes cannot succeed
        if ([4401, 4403, 4404, 4410, 4429].includes(event.code)) this.provider.disconnect();
      }
    });
  }

  get synced(): boolean {
    return this.provider.synced;
  }

  paragraph(): Y.XmlText {
    const fragment = this.doc.getXmlFragment('content');
    if (fragment.length === 0) {
      const element = new Y.XmlElement('paragraph');
      element.insert(0, [new Y.XmlText()]);
      fragment.insert(0, [element]);
    }
    return (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText;
  }

  text(): string {
    const first = this.doc.getXmlFragment('content').get(0) as Y.XmlElement | undefined;
    return (first?.get(0) as Y.XmlText | undefined)?.toString() ?? '';
  }

  event<T extends CollabRoomEvent['type']>(
    type: T,
  ): Extract<CollabRoomEvent, { type: T }> | undefined {
    return [...this.events].reverse().find((e) => e.type === type) as never;
  }

  destroy(): void {
    this.provider.destroy();
    this.doc.destroy();
  }
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe('collab gateway', () => {
  let collab: RunningCollab;
  let prisma: PrismaClient;
  let redis: Redis;
  let stateReader: DocumentStateReader;
  let rooms: RoomManager;
  const clients: Client[] = [];

  async function makeUser(): Promise<TestUser> {
    const user = await prisma.user.create({
      data: {
        email: `collab-${randomBytes(6).toString('hex')}@collab-test.example`,
        name: 'Test User',
        passwordHash: 'x',
      },
    });
    return { id: user.id };
  }

  /** A workspace with one user per role and a document everybody in the workspace can open. */
  async function setup() {
    const [owner, editor, viewer, outsider] = await Promise.all([
      makeUser(),
      makeUser(),
      makeUser(),
      makeUser(),
    ]);
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Collab',
        slug: `collab-${randomBytes(6).toString('hex')}`,
        ownerId: owner.id,
        subscription: { create: {} },
      },
    });
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
        { workspaceId: workspace.id, userId: editor.id, role: 'EDITOR' },
        { workspaceId: workspace.id, userId: viewer.id, role: 'VIEWER' },
      ],
    });
    const document = await prisma.document.create({
      data: { workspaceId: workspace.id, createdBy: owner.id, position: 'a0', title: 'Doc' },
    });
    return { workspace, owner, editor, viewer, outsider, documentId: document.id };
  }

  async function connect(user: TestUser, documentId: string): Promise<Client> {
    const ticket = await signCollabTicket(SECRET, { docId: documentId, sub: user.id });
    const client = new Client(collab.wsUrl, documentId, ticket);
    clients.push(client);
    return client;
  }

  /** The document as the database has it. */
  async function stored(documentId: string): Promise<string> {
    const doc = await stateReader.readDoc(documentId);
    const text = doc.getXmlFragment('content').toString();
    doc.destroy();
    return text;
  }

  const publish = (channel: string, payload: object) =>
    redis.publish(channel, JSON.stringify({ ...payload, correlationId: 'test-event' }));

  /** Opens a raw socket to learn the close code of a refused connection. */
  function closeCodeOf(documentId: string, ticket: string | null): Promise<number> {
    const query = ticket === null ? '' : `?ticket=${encodeURIComponent(ticket)}`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${collab.wsUrl}/${documentId}${query}`);
      socket.on('close', (code) => resolve(code));
      socket.on('error', reject);
    });
  }

  beforeAll(async () => {
    collab = await startCollab();
    prisma = collab.app.get(PrismaService);
    redis = collab.app.get(REDIS_CLIENT);
    stateReader = collab.app.get(DocumentStateReader);
    rooms = collab.app.get(RoomManager);
    await redis.flushdb();
  });

  afterEach(() => {
    clients.splice(0).forEach((client) => client.destroy());
  });

  afterAll(async () => {
    await collab.stop();
  });

  describe('editing', () => {
    it('lets two clients converge, including a concurrent edit of the same paragraph', async () => {
      const { editor, owner, documentId } = await setup();
      const a = await connect(editor, documentId);
      const b = await connect(owner, documentId);
      await waitFor(() => a.synced && b.synced, 'both clients to sync');

      a.paragraph().insert(0, 'base');
      await waitFor(() => b.text() === 'base', 'b to receive the first paragraph');

      a.paragraph().insert(2, 'AAA');
      b.paragraph().insert(2, 'BBB');
      await waitFor(() => a.text() === b.text() && a.text().length === 10, 'a and b to converge');
      expect(a.text()).toContain('AAA');
      expect(a.text()).toContain('BBB');
      await waitFor(
        async () => (await stored(documentId)) === a.doc.getXmlFragment('content').toString(),
        'the database to hold the converged document',
      );
    });

    it('merges what two clients wrote while both were disconnected, losing no insertion', async () => {
      const { editor, owner, documentId } = await setup();
      const a = await connect(editor, documentId);
      const b = await connect(owner, documentId);
      await waitFor(() => a.synced && b.synced, 'both clients to sync');
      a.paragraph().insert(0, 'base text');
      await waitFor(() => b.text() === 'base text', 'b to receive the paragraph');

      a.provider.disconnect();
      b.provider.disconnect();
      await waitFor(() => !a.provider.wsconnected && !b.provider.wsconnected, 'both to disconnect');

      // the same paragraph from both ends, a deletion, and a new block each
      a.paragraph().insert(4, '[A]');
      a.paragraph().insert(a.paragraph().length, ' end-A');
      b.paragraph().insert(4, '[B]');
      b.paragraph().delete(0, 2);
      for (const [client, name] of [
        [a, 'A'],
        [b, 'B'],
      ] as const) {
        const block = new Y.XmlElement('paragraph');
        block.insert(0, [new Y.XmlText(`block ${name}`)]);
        client.doc.getXmlFragment('content').push([block]);
      }
      expect(a.text()).not.toContain('[B]');
      expect(b.text()).not.toContain('[A]');

      a.provider.connect();
      b.provider.connect();
      const fragment = (client: Client) => client.doc.getXmlFragment('content').toString();
      await waitFor(() => a.synced && b.synced && fragment(a) === fragment(b), 'both to converge');
      for (const piece of ['[A]', '[B]', 'end-A', 'block A', 'block B']) {
        expect(fragment(a)).toContain(piece);
      }
      // b's deletion of the first two characters held
      expect(fragment(a)).not.toContain('base');
      await waitFor(
        async () => (await stored(documentId)) === fragment(a),
        'the database to hold the merged document',
      );
    });

    it('applies a late, duplicated copy of an update once', async () => {
      const { editor, owner, documentId } = await setup();
      const a = await connect(editor, documentId);
      const b = await connect(owner, documentId);
      await waitFor(() => a.synced && b.synced, 'both clients to sync');
      const sent: Uint8Array[] = [];
      a.doc.on('update', (update: Uint8Array) => sent.push(update));
      a.paragraph().insert(0, 'once');
      await waitFor(() => b.text() === 'once', 'b to receive the text');

      // the same update arrives again through another socket, as after a flaky reconnect
      const echo = await connect(editor, documentId);
      await waitFor(() => echo.synced, 'the echo client to sync');
      for (const update of sent) Y.applyUpdate(echo.doc, update);
      await settle(300);
      expect(b.text()).toBe('once');
      expect(echo.text()).toBe('once');
      await waitFor(
        async () => (await stored(documentId)).includes('once'),
        'the text to be stored',
      );
      expect(await stored(documentId)).not.toContain('onceonce');
    });

    it('tells a client when its changes are durable', async () => {
      const { editor, documentId } = await setup();
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'saved');
      await waitFor(() => {
        const persisted = client.event('persisted');
        if (!persisted) return false;
        const sv = Y.decodeStateVector(Buffer.from(persisted.sv, 'base64'));
        const local = Y.decodeStateVector(Y.encodeStateVector(client.doc));
        return [...local].every(([id, clock]) => (sv.get(id) ?? 0) >= clock);
      }, 'the persisted event to cover the local state');
    });

    it('lets a viewer read but not change the document', async () => {
      const { editor, viewer, documentId } = await setup();
      const writer = await connect(editor, documentId);
      await waitFor(() => writer.synced, 'writer sync');
      writer.paragraph().insert(0, 'original');

      const reader = await connect(viewer, documentId);
      await waitFor(() => reader.text() === 'original', 'viewer to receive the content');
      expect(reader.event('access')).toEqual({ type: 'access', level: 'VIEW', readOnly: true });

      reader.paragraph().insert(0, 'FORGED ');
      await settle(300);
      expect(writer.text()).toBe('original');
      await settle(400);
      expect(await stored(documentId)).not.toContain('FORGED');
    });

    it('survives an oversized frame (closed with 1009) and keeps serving the others', async () => {
      const { editor, documentId } = await setup();
      const healthy = await connect(editor, documentId);
      await waitFor(() => healthy.synced, 'sync');

      const ticket = await signCollabTicket(SECRET, { docId: documentId, sub: editor.id });
      const socket = new WebSocket(`${collab.wsUrl}/${documentId}?ticket=${ticket}`);
      const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
      await new Promise((resolve) => socket.on('open', resolve));
      socket.send(Buffer.alloc(parseConfig(process.env).COLLAB_MAX_UPDATE_BYTES + 1024, 1));
      await expect(closed).resolves.toBe(COLLAB_CLOSE.messageTooBig);

      healthy.paragraph().insert(0, 'still works');
      await waitFor(
        async () => (await stored(documentId)).includes('still works'),
        'the healthy client to keep saving',
      );
    });

    it('refuses connections beyond the per-document limit with 4429', async () => {
      const { editor, documentId } = await setup();
      const limit = parseConfig(process.env).COLLAB_MAX_CONNECTIONS_PER_DOCUMENT;
      for (let i = 0; i < limit; i += 1) await connect(editor, documentId);
      await waitFor(() => clients.every((c) => c.synced), 'the allowed clients to sync');
      const ticket = await signCollabTicket(SECRET, { docId: documentId, sub: editor.id });
      await expect(closeCodeOf(documentId, ticket)).resolves.toBe(COLLAB_CLOSE.rateLimited);
    });
  });

  describe('presence', () => {
    it('shows collaborators with the identity the server knows, not the one the client claims', async () => {
      const { editor, owner, documentId } = await setup();
      await prisma.user.update({ where: { id: editor.id }, data: { name: 'Eddie Editor' } });
      const a = await connect(editor, documentId);
      const b = await connect(owner, documentId);
      await waitFor(() => a.synced && b.synced, 'sync');

      a.provider.awareness.setLocalState({
        user: { id: owner.id, name: 'The Owner', color: '#000000' },
        cursor: { anchor: 1, head: 1 },
      });
      await waitFor(() => b.provider.awareness.getStates().has(a.doc.clientID), 'presence of a');
      expect(b.provider.awareness.getStates().get(a.doc.clientID)).toMatchObject({
        user: { id: editor.id, name: 'Eddie Editor' },
        cursor: { anchor: 1, head: 1 },
      });

      a.destroy();
      await waitFor(
        () => !b.provider.awareness.getStates().has(a.doc.clientID),
        'presence to clear',
      );
    });
  });

  describe('tickets and permissions at connect time', () => {
    it('closes with 4401 for a missing, malformed, expired or foreign ticket', async () => {
      const { editor, documentId } = await setup();
      const other = await setup();
      const expired = await signCollabTicket(
        SECRET,
        { docId: documentId, sub: editor.id },
        new Date(Date.now() - 5 * 60_000),
      );
      const forged = await signCollabTicket('another-secret-of-sufficient-length', {
        docId: documentId,
        sub: editor.id,
      });
      const forOtherDocument = await signCollabTicket(SECRET, {
        docId: other.documentId,
        sub: editor.id,
      });
      for (const ticket of [null, '', 'garbage', expired, forged, forOtherDocument]) {
        await expect(closeCodeOf(documentId, ticket)).resolves.toBe(COLLAB_CLOSE.ticketInvalid);
      }
    });

    it('closes with 4403 for a user without access to the document', async () => {
      const { outsider, documentId } = await setup();
      const ticket = await signCollabTicket(SECRET, { docId: documentId, sub: outsider.id });
      await expect(closeCodeOf(documentId, ticket)).resolves.toBe(COLLAB_CLOSE.forbidden);
    });

    it('closes with 4403 for a restricted document without a share, and admits with one', async () => {
      const { viewer, documentId } = await setup();
      await prisma.document.update({
        where: { id: documentId },
        data: { visibility: 'RESTRICTED' },
      });
      const ticket = await signCollabTicket(SECRET, { docId: documentId, sub: viewer.id });
      await expect(closeCodeOf(documentId, ticket)).resolves.toBe(COLLAB_CLOSE.forbidden);

      await prisma.documentShare.create({
        data: { documentId, userId: viewer.id, role: 'EDITOR' },
      });
      const client = await connect(viewer, documentId);
      await waitFor(() => client.synced, 'sync after the share');
      expect(client.event('access')).toMatchObject({ readOnly: false });
    });

    it('admits the editor who wrote a restricted document, and refuses a viewer author', async () => {
      const { editor, viewer, workspace } = await setup();
      const authored = await prisma.document.create({
        data: {
          workspaceId: workspace.id,
          createdBy: editor.id,
          position: 'a1',
          title: 'Authored',
          visibility: 'RESTRICTED',
        },
      });
      const client = await connect(editor, authored.id);
      await waitFor(() => client.synced, 'sync of the author');
      expect(client.event('access')).toMatchObject({ level: 'EDIT', readOnly: false });

      const viewerDoc = await prisma.document.create({
        data: {
          workspaceId: workspace.id,
          createdBy: viewer.id,
          position: 'a2',
          title: 'Viewer authored',
          visibility: 'RESTRICTED',
        },
      });
      const ticket = await signCollabTicket(SECRET, { docId: viewerDoc.id, sub: viewer.id });
      await expect(closeCodeOf(viewerDoc.id, ticket)).resolves.toBe(COLLAB_CLOSE.forbidden);
    });

    it('closes with 4404 for a document that does not exist and 4410 for a deleted one', async () => {
      const { editor, documentId } = await setup();
      const missing = randomUUID();
      const missingTicket = await signCollabTicket(SECRET, { docId: missing, sub: editor.id });
      await expect(closeCodeOf(missing, missingTicket)).resolves.toBe(COLLAB_CLOSE.notFound);

      await prisma.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
      const ticket = await signCollabTicket(SECRET, { docId: documentId, sub: editor.id });
      await expect(closeCodeOf(documentId, ticket)).resolves.toBe(COLLAB_CLOSE.deleted);
    });

    it('refuses a path that is not a document id', async () => {
      const ticket = await signCollabTicket(SECRET, { docId: 'x', sub: randomUUID() });
      await expect(closeCodeOf('not-a-uuid', ticket)).resolves.toBe(COLLAB_CLOSE.notFound);
    });
  });

  describe('admission', () => {
    it('decides access after the room has loaded, not before it', async () => {
      const { editor, workspace, documentId } = await setup();
      const realAcquire = rooms.acquire.bind(rooms);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let acquireCalled = false;
      const spy = jest.spyOn(rooms, 'acquire').mockImplementation(async (id: string) => {
        acquireCalled = true;
        await gate;
        return realAcquire(id);
      });
      try {
        const client = await connect(editor, documentId);
        await waitFor(() => acquireCalled, 'the admission to reach the room');
        // revoked while the room is still loading; the connection is not in the session map yet
        await prisma.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: editor.id } },
          data: { role: 'VIEWER' },
        });
        await publish(PERM_EVENT_CHANNELS.permChanged, {
          workspaceId: workspace.id,
          userId: editor.id,
          reason: 'role_changed',
        });
        await settle(50);
        release();

        const accessEvent = () => client.events.find((event) => event.type === 'access');
        await waitFor(() => accessEvent() !== undefined, 'the access event');
        expect(accessEvent()).toMatchObject({ level: 'VIEW', readOnly: true });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('permission changes on open sockets', () => {
    it('downgrades an editor to read-only on perm.changed and upgrades again', async () => {
      const { editor, workspace, owner, documentId } = await setup();
      const client = await connect(editor, documentId);
      const watcher = await connect(owner, documentId);
      await waitFor(() => client.synced && watcher.synced, 'sync');
      expect(client.event('access')).toMatchObject({ level: 'EDIT', readOnly: false });

      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: editor.id } },
        data: { role: 'VIEWER' },
      });
      await publish(PERM_EVENT_CHANNELS.permChanged, {
        workspaceId: workspace.id,
        userId: editor.id,
        reason: 'role_changed',
      });
      await waitFor(() => client.event('access')?.readOnly === true, 'the read-only notice');

      client.paragraph().insert(0, 'after downgrade');
      await settle(300);
      expect(watcher.text()).toBe('');
      expect(client.closes).toEqual([]);

      await prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: editor.id } },
        data: { role: 'EDITOR' },
      });
      await publish(PERM_EVENT_CHANNELS.permChanged, {
        workspaceId: workspace.id,
        userId: editor.id,
        reason: 'role_changed',
      });
      await waitFor(() => client.event('access')?.readOnly === false, 'the editable notice');
    });

    it('closes the socket with 4403 when the member is removed', async () => {
      const { editor, workspace, documentId } = await setup();
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      await prisma.workspaceMember.delete({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: editor.id } },
      });
      await publish(PERM_EVENT_CHANNELS.permChanged, {
        workspaceId: workspace.id,
        userId: editor.id,
        reason: 'member_removed',
      });
      await waitFor(() => client.closes.includes(COLLAB_CLOSE.forbidden), 'the 4403 close');
    });

    it('closes the socket of a removed member who held a share, once the share goes with the membership', async () => {
      const { editor, workspace, documentId } = await setup();
      await prisma.document.update({ where: { id: documentId }, data: { visibility: 'RESTRICTED' } });
      await prisma.documentShare.create({ data: { documentId, userId: editor.id, role: 'EDITOR' } });
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      // what the api's removal does in one transaction
      await prisma.$transaction([
        prisma.workspaceMember.delete({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: editor.id } },
        }),
        prisma.documentShare.deleteMany({
          where: { userId: editor.id, document: { workspaceId: workspace.id } },
        }),
      ]);
      await publish(PERM_EVENT_CHANNELS.permChanged, {
        workspaceId: workspace.id,
        userId: editor.id,
        reason: 'member_removed',
      });
      await waitFor(() => client.closes.includes(COLLAB_CLOSE.forbidden), 'the 4403 close');
      const ticket = await signCollabTicket(SECRET, { docId: documentId, sub: editor.id });
      await expect(closeCodeOf(documentId, ticket)).resolves.toBe(COLLAB_CLOSE.forbidden);
    });

    it('re-evaluates everybody when a document changes visibility (no user in the event)', async () => {
      const { editor, viewer, workspace, documentId } = await setup();
      const a = await connect(editor, documentId);
      const b = await connect(viewer, documentId);
      await waitFor(() => a.synced && b.synced, 'sync');
      await prisma.document.update({
        where: { id: documentId },
        data: { visibility: 'RESTRICTED' },
      });
      await publish(PERM_EVENT_CHANNELS.permChanged, {
        workspaceId: workspace.id,
        documentId,
        reason: 'visibility_changed',
      });
      await waitFor(
        () =>
          a.closes.includes(COLLAB_CLOSE.forbidden) && b.closes.includes(COLLAB_CLOSE.forbidden),
        'both sockets to be closed',
      );
    });

    it('sends "deleted" and closes with 4410 when the document is deleted', async () => {
      const { editor, owner, workspace, documentId } = await setup();
      const a = await connect(editor, documentId);
      const b = await connect(owner, documentId);
      await waitFor(() => a.synced && b.synced, 'sync');
      a.paragraph().insert(0, 'last words');
      await waitFor(() => b.text() === 'last words', 'delivery before deletion');

      await prisma.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } });
      await publish(PERM_EVENT_CHANNELS.docDeleted, {
        workspaceId: workspace.id,
        documentIds: [documentId],
      });
      await waitFor(
        () => a.closes.includes(COLLAB_CLOSE.deleted) && b.closes.includes(COLLAB_CLOSE.deleted),
        'both sockets to close with 4410',
      );
      expect(a.event('deleted')).toEqual({ type: 'deleted' });
      // the content is kept for a later restore
      expect(await stored(documentId)).toContain('last words');
    });

    it('notices a revoked or expired guest link on the timer, without any event', async () => {
      const { owner, documentId } = await setup();
      const link = await prisma.publicLink.create({
        data: {
          documentId,
          mode: 'EDIT',
          tokenHash: randomBytes(16).toString('hex'),
          createdBy: owner.id,
        },
      });
      const ticket = await signCollabTicket(SECRET, { docId: documentId, linkId: link.id });
      const guest = new Client(collab.wsUrl, documentId, ticket);
      clients.push(guest);
      await waitFor(() => guest.synced, 'guest sync');
      expect(guest.event('access')).toMatchObject({ level: 'EDIT', readOnly: false });

      await prisma.publicLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await waitFor(
        () => guest.closes.includes(COLLAB_CLOSE.forbidden),
        'the guest to be cut off',
        RECHECK_MS * 5,
      );
    });

    it('names the guests in the order they arrive', async () => {
      const { owner, editor, documentId } = await setup();
      const link = await prisma.publicLink.create({
        data: {
          documentId,
          mode: 'EDIT',
          tokenHash: randomBytes(16).toString('hex'),
          createdBy: owner.id,
        },
      });
      const watcher = await connect(editor, documentId);
      await waitFor(() => watcher.synced, 'sync');
      const guests: Client[] = [];
      for (let arrival = 1; arrival <= 2; arrival++) {
        const ticket = await signCollabTicket(SECRET, { docId: documentId, linkId: link.id });
        const guest = new Client(collab.wsUrl, documentId, ticket);
        clients.push(guest);
        guests.push(guest);
        await waitFor(() => guest.synced, 'guest sync');
        guest.provider.awareness.setLocalState({ user: { name: 'Mallory' } });
      }
      const namesSeen = () =>
        [...watcher.provider.awareness.getStates().values()]
          .map((state) => (state as { user?: { name?: string } }).user?.name)
          .filter((name) => name?.startsWith('Guest'))
          .sort();
      await waitFor(() => namesSeen().length === 2, 'both guests to show up');
      expect(namesSeen()).toEqual(['Guest 1', 'Guest 2']);
    });

    it('refuses a guest ticket for a revoked link', async () => {
      const { owner, documentId } = await setup();
      const link = await prisma.publicLink.create({
        data: {
          documentId,
          mode: 'EDIT',
          tokenHash: randomBytes(16).toString('hex'),
          createdBy: owner.id,
          revokedAt: new Date(),
        },
      });
      const ticket = await signCollabTicket(SECRET, { docId: documentId, linkId: link.id });
      await expect(closeCodeOf(documentId, ticket)).resolves.toBe(COLLAB_CLOSE.forbidden);
    });
  });

  describe('rooms', () => {
    it('unloads an idle room and brings the document back from the store', async () => {
      const { editor, documentId } = await setup();
      const first = await connect(editor, documentId);
      await waitFor(() => first.synced, 'sync');
      first.paragraph().insert(0, 'remember me');
      await waitFor(
        async () => (await stored(documentId)).includes('remember me'),
        'the update to reach the database',
      );
      expect(rooms.roomCount()).toBeGreaterThan(0);
      first.destroy();
      await waitFor(
        async () => (await rooms.find(documentId)) === undefined,
        'the room to unload',
        IDLE_MS * 10,
      );

      const second = await connect(editor, documentId);
      await waitFor(() => second.text() === 'remember me', 'the cold start to restore the content');
    });
  });

  describe('persistence on timers', () => {
    const count = (documentId: string, kind: 'AUTO' | 'MANUAL' | 'PRE_RESTORE') =>
      prisma.documentVersion.count({ where: { documentId, kind } });

    it('writes on its own shortly after the last keystroke and then reports it as durable', async () => {
      const { editor, documentId } = await setup();
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'timer');
      await waitFor(async () => (await stored(documentId)).includes('timer'), 'the flush timer');
      await waitFor(() => {
        const persisted = client.event('persisted');
        return !!persisted && persisted.sv.length > 0;
      }, 'the persisted event');
    });

    it('keeps the update log bounded by compacting it', async () => {
      const { editor, documentId } = await setup();
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      const limit = parseConfig(process.env).COLLAB_COMPACT_MAX_ROWS;
      let most = 0;
      for (let i = 0; i < 16; i += 1) {
        client.paragraph().insert(client.paragraph().length, `w${i} `);
        await settle(110); // longer than the flush interval: every edit becomes its own row
        most = Math.max(most, await prisma.documentUpdate.count({ where: { documentId } }));
      }
      expect(most).toBeLessThanOrEqual(limit);
      expect(await prisma.documentState.count({ where: { documentId } })).toBe(1);
      const doc = await stateReader.readDoc(documentId);
      expect(doc.getXmlFragment('content').toString()).toContain('w15');
      expect(doc.getXmlFragment('content').toString()).toContain('w0');
    });

    it('takes an automatic version at most once per interval, and only when there are changes', async () => {
      const { editor, documentId } = await setup();
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      await settle(900);
      expect(await count(documentId, 'AUTO')).toBe(0);

      client.paragraph().insert(0, 'a');
      await waitFor(
        async () => (await count(documentId, 'AUTO')) === 1,
        'the first automatic version',
      );
      client.paragraph().insert(1, 'b');
      await settle(300);
      expect(await count(documentId, 'AUTO')).toBe(1);

      await settle(700);
      client.paragraph().insert(2, 'c');
      await waitFor(
        async () => (await count(documentId, 'AUTO')) === 2,
        'the second automatic version',
      );
    });

    it('retries a failed write by itself', async () => {
      const { editor, documentId } = await setup();
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      const append = jest
        .spyOn(DocumentStateWriter.prototype, 'append')
        .mockRejectedValueOnce(new Error('connection reset'));
      client.paragraph().insert(0, 'retried');
      await waitFor(() => append.mock.calls.length >= 1, 'the failing write');
      expect(await stored(documentId)).toBe('');
      await waitFor(
        async () => (await stored(documentId)).includes('retried'),
        'the retry to succeed',
        8000,
      );
      expect(append.mock.calls.length).toBeGreaterThanOrEqual(2);
      jest.restoreAllMocks();
    });
  });

  describe('operations', () => {
    it('serves health, readiness and metrics', async () => {
      await expect(fetch(`${collab.httpUrl}/health`).then((r) => r.json())).resolves.toMatchObject({
        status: 'ok',
      });
      const ready = await fetch(`${collab.httpUrl}/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({
        status: 'ok',
        details: { redis: { status: 'up' }, postgres: { status: 'up' } },
      });

      const { editor, documentId } = await setup();
      const client = await connect(editor, documentId);
      await waitFor(() => client.synced, 'sync');
      client.paragraph().insert(0, 'metrics');
      await settle(200);
      const metrics = await (
        await fetch(`${collab.httpUrl}/metrics`, {
          headers: { authorization: `Bearer ${process.env.METRICS_TOKEN}` },
        })
      ).text();
      expect(metrics).toMatch(/collab_connections \d+/);
      expect(metrics).toMatch(/collab_rooms \d+/);
      expect(metrics).toMatch(/collab_updates_applied_total [1-9]/);
      expect(metrics).toContain('collab_updates_duplicate_total');
      expect(metrics).toContain('collab_ws_close_total');
    });

    it('hands out metrics only to the holder of the metrics token, on the port that browsers can reach', async () => {
      for (const authorization of [undefined, 'Bearer wrong', 'Basic x']) {
        const response = await fetch(`${collab.httpUrl}/metrics`, {
          headers: authorization ? { authorization } : {},
        });
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain('collab_connections');
      }
    });

    it('requires the internal token on port 4002', async () => {
      const status = COLLAB_INTERNAL.status;
      expect((await collab.send(status, {}, { token: null })).status).toBe(401);
      expect((await collab.send(status, {}, { token: 'wrong' })).status).toBe(401);
      const ok = await collab.send(status, {});
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ rooms: expect.any(Number), connections: expect.any(Number) });
    });

    it('does not expose the internal API on the public port', async () => {
      const response = await fetch(`${collab.httpUrl}/internal/status`, {
        headers: { authorization: `Bearer ${parseConfig(process.env).INTERNAL_API_TOKEN}` },
      });
      expect(response.status).toBe(404);
    });
  });
});
