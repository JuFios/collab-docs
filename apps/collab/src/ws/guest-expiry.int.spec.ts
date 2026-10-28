import '../test/env/guest-expiry';
import '../test/setup-env';
import { randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { DocumentStateReader, type PrismaClient } from '@collab-docs/db';
import { COLLAB_CLOSE } from '@collab-docs/shared';
import { parseConfig, signCollabTicket } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { type RunningCollab, startCollab } from '../test/collab-app';

const SECRET = parseConfig(process.env).COLLAB_TICKET_SECRET;
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

describe('guest with an edit link that expires', () => {
  let collab: RunningCollab;
  let prisma: PrismaClient;
  let reader: DocumentStateReader;
  const guests: { destroy(): void }[] = [];

  beforeAll(async () => {
    collab = await startCollab();
    prisma = collab.app.get(PrismaService);
    reader = collab.app.get(DocumentStateReader);
  });

  afterEach(() => {
    guests.splice(0).forEach((guest) => guest.destroy());
  });

  afterAll(async () => {
    await collab.stop();
  });

  async function guestWithLink(expiresInMs: number) {
    const owner = await prisma.user.create({
      data: {
        email: `guest-expiry-${randomBytes(6).toString('hex')}@collab-test.example`,
        name: 'Owner',
        passwordHash: 'x',
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: 'Guests',
        slug: `guests-${randomBytes(6).toString('hex')}`,
        ownerId: owner.id,
        subscription: { create: {} },
      },
    });
    const document = await prisma.document.create({
      data: { workspaceId: workspace.id, createdBy: owner.id, position: 'a0', title: 'Doc' },
    });
    const link = await prisma.publicLink.create({
      data: {
        documentId: document.id,
        mode: 'EDIT',
        tokenHash: randomBytes(16).toString('hex'),
        createdBy: owner.id,
        expiresAt: new Date(Date.now() + expiresInMs),
      },
    });
    const ticket = await signCollabTicket(SECRET, { docId: document.id, linkId: link.id });
    const doc = new Y.Doc();
    const closes: number[] = [];
    const provider = new WebsocketProvider(collab.wsUrl, document.id, doc, {
      WebSocketPolyfill: WebSocket as never,
      params: { ticket },
      disableBc: true,
      maxBackoffTime: 100,
    });
    provider.on('connection-close', (event: { code: number } | null) => {
      if (!event) return;
      closes.push(event.code);
      // as the real client does: reconnecting after these codes cannot succeed
      if (event.code === COLLAB_CLOSE.forbidden) provider.disconnect();
    });
    const write = (text: string) => {
      const fragment = doc.getXmlFragment('content');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText(text)]);
      fragment.insert(0, [paragraph]);
    };
    const stored = async () => {
      const state = await reader.readDoc(document.id);
      const text = state.getXmlFragment('content').toString();
      state.destroy();
      return text;
    };
    const guest = {
      link,
      provider,
      closes,
      write,
      stored,
      expiresAt: link.expiresAt!.getTime(),
      destroy: () => provider.destroy(),
    };
    guests.push(guest);
    return guest;
  }

  it('is cut off when the link expires, not when the next periodic check happens', async () => {
    const guest = await guestWithLink(1500);
    await waitFor(() => guest.provider.synced, 'the guest to sync');
    guest.write('written while the link is live');
    await waitFor(
      async () => (await guest.stored()).includes('while the link is live'),
      'the first write to be stored',
    );

    await wait(Math.max(0, guest.expiresAt - Date.now()) + 800);
    expect(guest.closes).toContain(COLLAB_CLOSE.forbidden);

    guest.write('LATE WRITE after the expiry');
    await wait(1000);
    expect(await guest.stored()).not.toContain('LATE WRITE');
    guest.destroy();
  });
});
