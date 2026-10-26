import { randomBytes } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import type { PrismaClient } from '@collab-docs/db';
import { COLLAB_MESSAGE, type CollabRoomEvent } from '@collab-docs/shared';
import { currentConfig, signCollabTicket } from '@collab-docs/nest';

export interface TestUser {
  id: string;
}

/** A y-websocket client the way the editor uses it, recording room events and close codes. */
export class Client {
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
      if (!event) return;
      this.closes.push(event.code);
      if ([4401, 4403, 4404, 4410, 4429].includes(event.code)) this.provider.disconnect();
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

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

export async function makeUser(prisma: PrismaClient): Promise<TestUser> {
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
export async function makeTeam(prisma: PrismaClient) {
  const [owner, editor, viewer, outsider] = await Promise.all([
    makeUser(prisma),
    makeUser(prisma),
    makeUser(prisma),
    makeUser(prisma),
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

export async function ticketFor(user: TestUser, documentId: string): Promise<string> {
  return signCollabTicket(currentConfig().COLLAB_TICKET_SECRET, {
    docId: documentId,
    sub: user.id,
  });
}
