/** Keyset position in the list order (newest first: `created_at`, then id, both descending). */
interface NotificationCursor {
  /** `created_at` as the text Postgres printed (microseconds), so the round trip is exact. */
  createdAt: string;
  id: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt, i: cursor.id })).toString('base64url');
}

/** `null` for anything that is not a cursor this module issued (it ends up in a query, so it is checked strictly). */
export function decodeNotificationCursor(raw: string): NotificationCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { t, i } = value as Record<string, unknown>;
    return typeof t === 'string' && TIMESTAMP.test(t) && typeof i === 'string' && UUID.test(i)
      ? { createdAt: t, id: i }
      : null;
  } catch {
    return null;
  }
}
