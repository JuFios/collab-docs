import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** One entry of an awareness update; `state` is `null` when the client removes its presence. */
export interface AwarenessEntry {
  clientId: number;
  clock: number;
  state: unknown;
}

/** Wire format of `y-protocols/awareness`: `len, (clientId, clock, JSON state)*`. Throws on malformed input. */
export function decodeAwarenessUpdate(update: Uint8Array): AwarenessEntry[] {
  const decoder = decoding.createDecoder(update);
  const length = decoding.readVarUint(decoder);
  if (length > 1024) throw new Error('too many awareness entries');
  const entries: AwarenessEntry[] = [];
  for (let i = 0; i < length; i += 1) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    entries.push({ clientId, clock, state: JSON.parse(decoding.readVarString(decoder)) });
  }
  return entries;
}

export function encodeAwarenessUpdate(entries: readonly AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}
