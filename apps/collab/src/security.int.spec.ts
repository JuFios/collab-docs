import './test/security-env';
import './test/setup-env';
import { randomBytes, randomUUID } from 'node:crypto';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { DocumentStateReader, type PrismaClient } from '@collab-docs/db';
import { COLLAB_CLOSE, COLLAB_MESSAGE } from '@collab-docs/shared';
import { REDIS_CLIENT, parseConfig, signCollabTicket } from '@collab-docs/nest';
import type { Redis } from 'ioredis';
import { PrismaService } from './prisma/prisma.service';
import { type RunningCollab, startCollab } from './test/collab-app';

const config = parseConfig(process.env);
const SECRET = config.COLLAB_TICKET_SECRET;

/** The only reasons the server may give for closing a socket: fixed texts, nothing taken from an error. */
const CLOSE_REASONS = new Set([
  'document not found',
  'document deleted',
  'ticket invalid',
  'no access',
  'access revoked',
  'rate limited',
  'too many connections',
  'server shutting down',
  'internal error',
]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await wait(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A small deterministic generator, so that a failing fuzz run can be replayed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const frame = (type: number, write: (encoder: encoding.Encoder) => void): Uint8Array => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
};

/** A socket that records how it ended. */
class RawSocket {
  readonly socket: WebSocket;
  closed: { code: number; reason: string } | null = null;
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.socket.on('error', () => undefined);
    this.opened = new Promise((resolve) => this.socket.on('open', () => resolve()));
  }

  send(data: Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(data);
  }
}

describe('collab security', () => {
  let collab: RunningCollab;
  let prisma: PrismaClient;
  let redis: Redis;
  let reader: DocumentStateReader;
  const sockets: RawSocket[] = [];

  async function makeUser(): Promise<{ id: string }> {
    const user = await prisma.user.create({
      data: {
        email: `sec-${randomBytes(6).toString('hex')}@collab-test.example`,
        name: 'Test User',
        passwordHash: 'x',
      },
    });
    return { id: user.id };
  }

  /** A workspace with an owner, an editor, a viewer and a document that holds the text `original`. */
  async function setup() {
    const [owner, editor, viewer] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Security',
        slug: `sec-${randomBytes(6).toString('hex')}`,
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
    return { owner, editor, viewer, documentId: document.id };
  }

  async function open(documentId: string, claims: { sub?: string; linkId?: string }) {
    const ticket = await signCollabTicket(SECRET, { docId: documentId, ...claims });
    const socket = new RawSocket(`${collab.wsUrl}/${documentId}?ticket=${ticket}`);
    sockets.push(socket);
    await socket.opened;
    return socket;
  }

  const text = async (documentId: string): Promise<string> => {
    const doc = await reader.readDoc(documentId);
    const content = doc.getXmlFragment('content').toString();
    doc.destroy();
    return content;
  };

  /** A paragraph update as a legitimate editor would send it. */
  function paragraphUpdate(content: string): Uint8Array {
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(content)]);
    doc.getXmlFragment('content').insert(0, [paragraph]);
    return Y.encodeStateAsUpdate(doc);
  }

  const updateFrame = (update: Uint8Array) =>
    frame(COLLAB_MESSAGE.sync, (e) => syncProtocol.writeUpdate(e, update));
  const step2Frame = (update: Uint8Array) =>
    frame(COLLAB_MESSAGE.sync, (e) => {
      encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2);
      encoding.writeVarUint8Array(e, update);
    });

  /** Writes `content` into the document the way an editor does, and waits until it is stored. */
  async function seed(documentId: string, editorId: string, content: string) {
    const socket = await open(documentId, { sub: editorId });
    socket.send(updateFrame(paragraphUpdate(content)));
    await waitFor(async () => (await text(documentId)).includes(content), 'the seed to be stored');
    return socket;
  }

  beforeAll(async () => {
    collab = await startCollab();
    prisma = collab.app.get(PrismaService);
    redis = collab.app.get(REDIS_CLIENT);
    reader = collab.app.get(DocumentStateReader);
    await redis.flushdb();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.socket.terminate();
  });

  afterAll(async () => {
    await collab.stop();
  });

  describe('limits', () => {
    it('closes a socket that floods the room with 4429 and keeps serving the others', async () => {
      const { editor, documentId } = await setup();
      const flooder = await open(documentId, { sub: editor.id });
      const healthy = await seed(documentId, editor.id, 'before the flood');

      const query = frame(COLLAB_MESSAGE.queryAwareness, () => undefined);
      for (let i = 0; i < config.COLLAB_MAX_MESSAGES_PER_10S * 3; i += 1) flooder.send(query);
      await waitFor(() => flooder.closed !== null, 'the flooder to be closed');
      expect(flooder.closed).toEqual({ code: COLLAB_CLOSE.rateLimited, reason: 'rate limited' });

      healthy.send(updateFrame(paragraphUpdate('after the flood')));
      await waitFor(
        async () => (await text(documentId)).includes('after the flood'),
        'the healthy socket to keep saving',
      );
    });

    it('stops accepting content once the document reaches its size limit, without dropping anyone', async () => {
      const { editor, documentId } = await setup();
      const socket = await open(documentId, { sub: editor.id });
      const big = 'x'.repeat(config.COLLAB_MAX_DOCUMENT_BYTES / 4);
      // five times the limit in total, in updates that are each far below the per-update limit
      for (let i = 0; i < 20; i += 1) {
        socket.send(updateFrame(paragraphUpdate(`${i}:${big}`)));
        await wait(10);
      }
      await wait(600);
      const stored = await text(documentId);
      expect(stored.length).toBeLessThan(config.COLLAB_MAX_DOCUMENT_BYTES * 1.5);
      expect(stored.length).toBeGreaterThan(0);
      expect(socket.closed).toBeNull();
    });

    it('rejects awareness payloads over the limit and stays open', async () => {
      const { editor, documentId } = await setup();
      const socket = await open(documentId, { sub: editor.id });
      const awareness = new awarenessProtocol.Awareness(new Y.Doc());
      awareness.setLocalState({ cursor: 'c'.repeat(config.COLLAB_MAX_AWARENESS_BYTES * 4) });
      socket.send(
        frame(COLLAB_MESSAGE.awareness, (e) =>
          encoding.writeVarUint8Array(
            e,
            awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID]),
          ),
        ),
      );
      await wait(300);
      expect(socket.closed).toBeNull();
      awareness.destroy();
    });
  });

  describe('awareness', () => {
    /** The presence another client would see, read through a raw observer socket. */
    function observe(socket: RawSocket) {
      const observer = new awarenessProtocol.Awareness(new Y.Doc());
      socket.socket.on('message', (data: Buffer) => {
        const decoder = decoding.createDecoder(new Uint8Array(data));
        if (decoding.readVarUint(decoder) !== COLLAB_MESSAGE.awareness) return;
        awarenessProtocol.applyAwarenessUpdate(
          observer,
          decoding.readVarUint8Array(decoder),
          'server',
        );
      });
      return observer;
    }

    it('does not let a client speak for another client or invent an identity', async () => {
      const { editor, owner, documentId } = await setup();
      const victim = await open(documentId, { sub: owner.id });
      const watcher = await open(documentId, { sub: editor.id });
      const seen = observe(watcher);

      const honest = new awarenessProtocol.Awareness(new Y.Doc());
      honest.setLocalState({ user: { name: 'Owner' } });
      victim.send(
        frame(COLLAB_MESSAGE.awareness, (e) =>
          encoding.writeVarUint8Array(
            e,
            awarenessProtocol.encodeAwarenessUpdate(honest, [honest.clientID]),
          ),
        ),
      );
      await waitFor(() => seen.getStates().has(honest.clientID), 'the owner to show up');

      // the attacker claims the victim's presence id, and an id of its own with a forged name
      const attacker = await open(documentId, { sub: editor.id });
      const forged = new awarenessProtocol.Awareness(new Y.Doc());
      forged.setLocalState({ user: { id: owner.id, name: 'Administrator', color: '#ff0000' } });
      const own = forged.clientID;
      const hijack = new awarenessProtocol.Awareness(new Y.Doc());
      Object.defineProperty(hijack, 'clientID', { value: honest.clientID });
      hijack.setLocalState({ user: { id: owner.id, name: 'Administrator' } });
      for (const source of [forged, hijack]) {
        attacker.send(
          frame(COLLAB_MESSAGE.awareness, (e) =>
            encoding.writeVarUint8Array(
              e,
              awarenessProtocol.encodeAwarenessUpdate(source, [source.clientID]),
            ),
          ),
        );
      }
      await waitFor(() => seen.getStates().has(own), 'the attacker to show up');

      const names = [...seen.getStates().values()].map(
        (state) => (state as { user?: { name?: string } }).user?.name,
      );
      expect(names).not.toContain('Administrator');
      // the victim's presence is untouched, the attacker's carries the name the server knows
      expect(seen.getStates().get(honest.clientID)).toMatchObject({ user: { name: 'Test User' } });
      expect(seen.getStates().get(own)).toMatchObject({ user: { name: 'Test User' } });
      expect(attacker.closed).toBeNull();
      [honest, forged, hijack, seen].forEach((awareness) => awareness.destroy());
    });
  });

  describe('close reasons', () => {
    it('never carry anything but a fixed text', async () => {
      const { editor, documentId } = await setup();
      const other = await setup();
      const expired = await signCollabTicket(
        SECRET,
        { docId: documentId, sub: editor.id },
        new Date(Date.now() - 10 * 60_000),
      );
      const attempts: Array<[string, string | null]> = [
        [documentId, null],
        [documentId, ''],
        [documentId, 'not.a.jwt'],
        [documentId, `${expired}`],
        [documentId, await signCollabTicket(SECRET, { docId: other.documentId, sub: editor.id })],
        [
          documentId,
          await signCollabTicket('wrong-secret-wrong-secret-wrong-secret', {
            docId: documentId,
            sub: editor.id,
          }),
        ],
        [randomUUID(), await signCollabTicket(SECRET, { docId: documentId, sub: editor.id })],
        ['not-a-uuid', null],
        [documentId, await signCollabTicket(SECRET, { docId: documentId, sub: randomUUID() })],
      ];
      const outcomes: Array<{ code: number; reason: string }> = [];
      for (const [id, ticket] of attempts) {
        const query = ticket === null ? '' : `?ticket=${encodeURIComponent(ticket)}`;
        const socket = new RawSocket(`${collab.wsUrl}/${encodeURIComponent(id)}${query}`);
        sockets.push(socket);
        await waitFor(() => socket.closed !== null, 'the refusal');
        outcomes.push(socket.closed!);
      }
      for (const { code, reason } of outcomes) {
        expect([4401, 4403, 4404]).toContain(code);
        expect(CLOSE_REASONS.has(reason)).toBe(true);
      }
    });

    it('stay free of error details when the client sends garbage', async () => {
      const { editor, documentId } = await setup();
      const socket = await open(documentId, { sub: editor.id });
      const random = prng(7);
      for (let i = 0; i < 25; i += 1) {
        socket.send(
          Uint8Array.from({ length: 1 + Math.floor(random() * 40) }, () =>
            Math.floor(random() * 256),
          ),
        );
      }
      socket.socket.send('this is text, not a binary frame');
      await wait(300);
      // garbage is dropped and logged; it never turns into a close reason that echoes the parser's complaint
      if (socket.closed) expect(CLOSE_REASONS.has(socket.closed.reason)).toBe(true);
    });
  });

  describe('read-only sockets', () => {
    it('cannot change the document with any frame, however it is built', async () => {
      const { editor, viewer, documentId } = await setup();
      await seed(documentId, editor.id, 'original');
      const before = await text(documentId);

      const viewerSocket = await open(documentId, { sub: viewer.id });

      const random = prng(20261027);
      const forged = paragraphUpdate('FORGED');
      const valid = [updateFrame(forged), step2Frame(forged)];
      const frames: Uint8Array[] = [...valid];
      // flips of single bytes in valid frames, prefixes of them, and noise behind a sync/awareness header
      for (let i = 0; i < 40; i += 1) {
        const base = valid[i % valid.length]!.slice();
        base[Math.floor(random() * base.length)] = Math.floor(random() * 256);
        frames.push(base);
        frames.push(base.slice(0, 1 + Math.floor(random() * base.length)));
        const noise = Uint8Array.from({ length: 1 + Math.floor(random() * 60) }, () =>
          Math.floor(random() * 256),
        );
        frames.push(
          Uint8Array.from([i % 2 === 0 ? COLLAB_MESSAGE.sync : COLLAB_MESSAGE.awareness, ...noise]),
        );
      }
      // stay under the per-socket message limit: the point is the permission, not the flood protection
      for (const message of frames.slice(0, config.COLLAB_MAX_MESSAGES_PER_10S - 2))
        viewerSocket.send(message);
      await wait(700);

      expect(await text(documentId)).toBe(before);
      expect(await text(documentId)).not.toContain('FORGED');

      // the room still works for those who may write
      const editorSocket = await open(documentId, { sub: editor.id });
      editorSocket.send(updateFrame(paragraphUpdate('still writable')));
      await waitFor(
        async () => (await text(documentId)).includes('still writable'),
        'the editor to write',
      );
    });

    it('is cut off when its edit link expires, and a ticket for the expired link opens nothing', async () => {
      const { owner, documentId } = await setup();
      const link = await prisma.publicLink.create({
        data: {
          documentId,
          mode: 'EDIT',
          tokenHash: randomBytes(16).toString('hex'),
          createdBy: owner.id,
        },
      });
      const guest = await open(documentId, { linkId: link.id });
      await prisma.publicLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await waitFor(
        () => guest.closed !== null,
        'the guest to be cut off',
        config.COLLAB_ACCESS_RECHECK_MS * 5,
      );
      expect(guest.closed?.code).toBe(COLLAB_CLOSE.forbidden);

      // whatever the cut-off client still sends goes nowhere
      guest.send(updateFrame(paragraphUpdate('LATE WRITE')));
      const again = new RawSocket(
        `${collab.wsUrl}/${documentId}?ticket=${await signCollabTicket(SECRET, { docId: documentId, linkId: link.id })}`,
      );
      sockets.push(again);
      await waitFor(() => again.closed !== null, 'the second refusal');
      expect(again.closed?.code).toBe(COLLAB_CLOSE.forbidden);
      await wait(300);
      expect(await text(documentId)).not.toContain('LATE WRITE');
    });
  });
});
