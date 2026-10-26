/** Keyset position in the result order (rank, then id, both descending). */
export interface SearchCursor {
  /** `ts_rank_cd` as the text Postgres printed, so the round trip is exact. */
  rank: string;
  id: string;
}

const RANK = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify({ r: cursor.rank, i: cursor.id })).toString('base64url');
}

/** `null` for anything that is not a cursor this module issued (it ends up in a query, so it is checked strictly). */
export function decodeCursor(raw: string): SearchCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { r, i } = value as Record<string, unknown>;
    return typeof r === 'string' && RANK.test(r) && typeof i === 'string' && UUID.test(i)
      ? { rank: r, id: i }
      : null;
  } catch {
    return null;
  }
}
