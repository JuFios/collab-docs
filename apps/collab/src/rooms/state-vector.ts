import { decodeStateVector, encodeStateVector } from '@collab-docs/shared';
import * as Y from 'yjs';

/**
 * The state vector of everything stored once `update` has been stored on top of what `stored` already covers.
 *
 * `Y.encodeStateVectorFromUpdate(update)` is not usable here: it only counts structs from clock 0, so for an
 * incremental update (the second keystroke of a client onwards) it reports nothing at all and the "Saved"
 * indicator never settles. This walks the structs of the update per client instead, and extends the stored clock
 * only while the update continues it without a gap; a client's structs that follow a missing range are not
 * claimed as stored.
 */
export function advanceStateVector(stored: Uint8Array, update: Uint8Array): Uint8Array {
  const vector = decodeStateVector(stored);
  const byClient = new Map<number, Y.AbstractStruct[]>();
  for (const struct of Y.decodeUpdate(update).structs) {
    if (struct instanceof Y.Skip) continue;
    const structs = byClient.get(struct.id.client);
    if (structs) structs.push(struct);
    else byClient.set(struct.id.client, [struct]);
  }
  for (const [client, structs] of byClient) {
    structs.sort((a, b) => a.id.clock - b.id.clock);
    let end = vector.get(client) ?? 0;
    for (const struct of structs) {
      if (struct.id.clock > end) break;
      end = Math.max(end, struct.id.clock + struct.length);
    }
    if (end > 0) vector.set(client, end);
  }
  return encodeStateVector(vector);
}
