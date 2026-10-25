/**
 * Yjs state vectors without importing Yjs, so the browser can compare them in code that never loads the
 * editor. Wire format (lib0): `varuint count, (varuint client, varuint clock)*`; a varuint is little-endian
 * base-128 with a continuation bit. Client ids are up to 32 bits wide, hence arithmetic instead of bit shifts.
 */

function readVarUint(bytes: Uint8Array, cursor: { pos: number }): number {
  let value = 0;
  let scale = 1;
  for (;;) {
    const byte = bytes[cursor.pos];
    if (byte === undefined) throw new Error('truncated state vector');
    cursor.pos += 1;
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 128;
    if (scale > Number.MAX_SAFE_INTEGER) throw new Error('state vector number too large');
  }
}

function writeVarUint(out: number[], value: number): void {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

export type StateVector = Map<number, number>;

export function decodeStateVector(bytes: Uint8Array): StateVector {
  const cursor = { pos: 0 };
  const count = readVarUint(bytes, cursor);
  const vector: StateVector = new Map();
  for (let i = 0; i < count; i += 1) {
    const client = readVarUint(bytes, cursor);
    vector.set(client, readVarUint(bytes, cursor));
  }
  return vector;
}

export function encodeStateVector(vector: StateVector): Uint8Array {
  const out: number[] = [];
  writeVarUint(out, vector.size);
  for (const [client, clock] of vector) {
    writeVarUint(out, client);
    writeVarUint(out, clock);
  }
  return Uint8Array.from(out);
}

/** The state that knows everything either argument knows. */
export function mergeStateVectors(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = decodeStateVector(a);
  for (const [client, clock] of decodeStateVector(b)) {
    if ((merged.get(client) ?? 0) < clock) merged.set(client, clock);
  }
  return encodeStateVector(merged);
}

/**
 * True when `persisted` includes every change `local` has: the check behind the "Saved" indicator and the
 * "publish only saved changes" rule. `y-websocket` does not acknowledge deliveries, so the server reports
 * what is durable as a state vector and the client compares.
 */
export function stateVectorCovers(persisted: Uint8Array, local: Uint8Array): boolean {
  const have = decodeStateVector(persisted);
  for (const [client, clock] of decodeStateVector(local)) {
    if ((have.get(client) ?? 0) < clock) return false;
  }
  return true;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
