import type { APIRequestContext } from '@playwright/test';
import { createDecoder, readVarUint } from 'lib0/decoding';
import { createEncoder, length, toUint8Array, writeVarUint } from 'lib0/encoding';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { ORIGIN } from './workspace';

const MESSAGE_SYNC = 0;

interface RawCollabClient {
  doc: Y.Doc;
  /** Resolves once the server's state has been merged into `doc`. */
  synced: Promise<void>;
  /** Resolves with the close code once the socket is closed (by either side). */
  closed: Promise<number>;
  /** Text of the document body, for comparing with what the browser shows. */
  text(): string;
  /** Sends a paragraph the way a hostile client would, straight over the socket. */
  injectParagraph(text: string): void;
  close(): void;
}

/**
 * A bare `y-websocket` peer for tests that must not go through the editor: it takes a ticket with the session of
 * `request` and speaks the sync protocol by hand, so it can do things the UI never would (write as a viewer).
 */
export async function connectRaw(
  request: APIRequestContext,
  documentId: string,
): Promise<RawCollabClient> {
  const response = await request.post(`/api/documents/${documentId}/collab-ticket`, {
    headers: { origin: ORIGIN },
  });
  if (!response.ok()) throw new Error(`ticket refused: ${response.status()}`);
  const { ticket, wsUrl } = (await response.json()) as { ticket: string; wsUrl: string };

  const doc = new Y.Doc();
  const ws = new WebSocket(`${wsUrl}/${documentId}?ticket=${encodeURIComponent(ticket)}`);
  ws.binaryType = 'arraybuffer';

  const synced = new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('close', (code) => reject(new Error(`closed with ${code} before the first sync`)));
    ws.on('open', () => {
      const encoder = createEncoder();
      writeVarUint(encoder, MESSAGE_SYNC);
      writeSyncStep1(encoder, doc);
      ws.send(toUint8Array(encoder));
    });
    ws.on('message', (data: ArrayBuffer) => {
      const decoder = createDecoder(new Uint8Array(data));
      if (readVarUint(decoder) !== MESSAGE_SYNC) return;
      const reply = createEncoder();
      writeVarUint(reply, MESSAGE_SYNC);
      const kind = readSyncMessage(decoder, reply, doc, 'server');
      if (length(reply) > 1) ws.send(toUint8Array(reply));
      // step 2 carries the state; a client that has it is in sync
      if (kind === 1) resolve();
    });
  });
  // a rejection after the first sync (the server closing the socket) is not an error of the test
  synced.catch(() => undefined);
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'server' || ws.readyState !== WebSocket.OPEN) return;
    const encoder = createEncoder();
    writeVarUint(encoder, MESSAGE_SYNC);
    writeUpdate(encoder, update);
    ws.send(toUint8Array(encoder));
  });

  return {
    doc,
    synced,
    closed,
    text: () => doc.getXmlFragment('content').toString(),
    injectParagraph(text) {
      doc.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(text)]);
        doc.getXmlFragment('content').insert(0, [paragraph]);
      });
    },
    close: () => ws.close(),
  };
}
