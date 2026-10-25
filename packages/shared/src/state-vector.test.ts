import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  decodeStateVector,
  encodeStateVector,
  mergeStateVectors,
  stateVectorCovers,
} from './state-vector';

function editedDoc(clientID: number, text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  const xml = new Y.XmlText();
  doc.getXmlFragment('content').insert(0, [xml]);
  xml.insert(0, text);
  return doc;
}

describe('state vectors', () => {
  it('reads and writes exactly what Yjs does, including 32-bit client ids', () => {
    const a = editedDoc(4_294_967_295, 'hello');
    const b = editedDoc(300, 'x');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    const bytes = Y.encodeStateVector(a);
    expect(decodeStateVector(bytes)).toEqual(Y.decodeStateVector(bytes));
    expect(encodeStateVector(decodeStateVector(bytes))).toEqual(bytes);
  });

  it('merges by taking the larger clock per client', () => {
    const a = editedDoc(10, 'aaaa');
    const b = editedDoc(10, 'aa');
    const c = editedDoc(20, 'c');
    const merged = decodeStateVector(
      mergeStateVectors(
        Y.encodeStateVector(b),
        mergeStateVectors(Y.encodeStateVector(a), Y.encodeStateVector(c)),
      ),
    );
    expect(merged.get(10)).toBe(decodeStateVector(Y.encodeStateVector(a)).get(10));
    expect(merged.get(20)).toBe(decodeStateVector(Y.encodeStateVector(c)).get(20));
  });

  it('tells whether the persisted state covers the local one', () => {
    const doc = editedDoc(1, 'abc');
    const persisted = Y.encodeStateVector(doc);
    expect(stateVectorCovers(persisted, Y.encodeStateVector(doc))).toBe(true);
    (doc.getXmlFragment('content').get(0) as Y.XmlText).insert(0, 'more');
    expect(stateVectorCovers(persisted, Y.encodeStateVector(doc))).toBe(false);
    expect(stateVectorCovers(Y.encodeStateVector(doc), persisted)).toBe(true);
    // an empty persisted state covers only an empty local state
    const empty = Y.encodeStateVector(new Y.Doc());
    expect(stateVectorCovers(empty, persisted)).toBe(false);
    expect(stateVectorCovers(empty, empty)).toBe(true);
  });

  it('rejects truncated input', () => {
    expect(() => decodeStateVector(Uint8Array.of(2, 1))).toThrow();
    expect(() => decodeStateVector(Uint8Array.of(0x80))).toThrow();
  });

  it('round-trips base64', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(Uint8Array.of(1, 2, 3))).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });
});
