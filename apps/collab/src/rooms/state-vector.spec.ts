import { decodeStateVector, stateVectorCovers } from '@collab-docs/shared';
import * as Y from 'yjs';
import { advanceStateVector } from './state-vector';

const EMPTY = Y.encodeStateVector(new Y.Doc());

/** A client document and the updates it produced, one per call of `type`. */
function client() {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  const text = new Y.XmlText();
  doc.getXmlFragment('content').insert(0, [text]);
  return {
    doc,
    updates,
    type(value: string) {
      text.insert(text.length, value);
      return updates[updates.length - 1]!;
    },
  };
}

describe('advanceStateVector', () => {
  it('covers a first update that starts at clock 0', () => {
    const peer = client();
    const first = Y.mergeUpdates(peer.updates);
    expect(stateVectorCovers(advanceStateVector(EMPTY, first), Y.encodeStateVector(peer.doc))).toBe(
      true,
    );
  });

  it('follows incremental updates that do not start at clock 0', () => {
    const peer = client();
    let stored = advanceStateVector(EMPTY, Y.mergeUpdates(peer.updates));
    for (const word of ['a', 'bc', 'def']) {
      stored = advanceStateVector(stored, peer.type(word));
      expect(stateVectorCovers(stored, Y.encodeStateVector(peer.doc))).toBe(true);
    }
  });

  it('follows several updates merged into one flush', () => {
    const peer = client();
    let stored = advanceStateVector(EMPTY, Y.mergeUpdates(peer.updates));
    const batch = [peer.type('x'), peer.type('y'), peer.type('z')];
    stored = advanceStateVector(stored, Y.mergeUpdates(batch));
    expect(stateVectorCovers(stored, Y.encodeStateVector(peer.doc))).toBe(true);
  });

  it('tracks every client of the update separately', () => {
    const a = client();
    const b = client();
    let stored = advanceStateVector(EMPTY, Y.mergeUpdates([...a.updates, ...b.updates]));
    stored = advanceStateVector(stored, Y.mergeUpdates([a.type('1'), b.type('2')]));
    expect(stateVectorCovers(stored, Y.encodeStateVector(a.doc))).toBe(true);
    expect(stateVectorCovers(stored, Y.encodeStateVector(b.doc))).toBe(true);
    expect(decodeStateVector(stored).size).toBe(2);
  });

  it('does not claim structs that follow a missing range', () => {
    const peer = client();
    let stored = advanceStateVector(EMPTY, Y.mergeUpdates(peer.updates));
    peer.type('lost');
    const next = peer.type('after the gap');
    const advanced = advanceStateVector(stored, next);
    expect(stateVectorCovers(advanced, Y.encodeStateVector(peer.doc))).toBe(false);
    expect(decodeStateVector(advanced)).toEqual(decodeStateVector(stored));
    // the missing update arrives later: now everything is contiguous
    stored = advanceStateVector(advanced, Y.mergeUpdates(peer.updates.slice(-2)));
    expect(stateVectorCovers(stored, Y.encodeStateVector(peer.doc))).toBe(true);
  });

  it('is idempotent for an update that is already stored', () => {
    const peer = client();
    const first = Y.mergeUpdates(peer.updates);
    const once = advanceStateVector(EMPTY, first);
    expect(decodeStateVector(advanceStateVector(once, first))).toEqual(decodeStateVector(once));
  });
});
