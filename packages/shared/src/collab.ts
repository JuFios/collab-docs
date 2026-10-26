import { z } from 'zod';
import { ACCESS_LEVELS } from './permissions';

/** Message types of the collab WebSocket protocol (spec §5); 0-3 are those of `y-websocket`. */
export const COLLAB_MESSAGE = {
  sync: 0,
  awareness: 1,
  auth: 2,
  queryAwareness: 3,
  /** JSON room events (`CollabRoomEvent`). */
  roomEvent: 100,
} as const;

/** Close codes the server uses. 1009 is sent by the WebSocket layer itself for oversized frames. */
export const COLLAB_CLOSE = {
  messageTooBig: 1009,
  /** Ticket missing, malformed, expired or for another document: fetch a new one. */
  ticketInvalid: 4401,
  /** No access to the document, or the access was revoked. Do not reconnect. */
  forbidden: 4403,
  /** The document does not exist. Do not reconnect. */
  notFound: 4404,
  /** The document was deleted. Do not reconnect. */
  deleted: 4410,
  /** Too many messages or connections. */
  rateLimited: 4429,
} as const;

/** Message patterns of the collab internal API (TCP, port 4002, never published). */
export const COLLAB_INTERNAL = {
  status: 'collab.status',
  flush: 'collab.flush',
  restore: 'collab.restore',
  close: 'collab.close',
} as const;

export type CollabCloseCode = (typeof COLLAB_CLOSE)[keyof typeof COLLAB_CLOSE];

/** Codes after which a client must call `provider.disconnect()`; reconnecting cannot succeed. */
export const COLLAB_FINAL_CLOSE_CODES: readonly number[] = [
  COLLAB_CLOSE.forbidden,
  COLLAB_CLOSE.notFound,
  COLLAB_CLOSE.deleted,
];

/**
 * Server → client events carried in message type 100 as JSON.
 * `persisted.sv` is a base64 Yjs state vector: everything it covers is stored in the database.
 */
export const collabRoomEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('persisted'), sv: z.string() }),
  z.object({
    type: z.literal('access'),
    level: z.enum(ACCESS_LEVELS),
    /** `level` is below EDIT: the server ignores this client's document updates. */
    readOnly: z.boolean(),
  }),
  z.object({ type: z.literal('deleted') }),
]);
export type CollabRoomEvent = z.infer<typeof collabRoomEventSchema>;

/** Response of `POST /documents/:id/collab-ticket`. */
export const collabTicketSchema = z.object({
  ticket: z.string(),
  /** Base URL for `y-websocket`: the provider appends `/<docId>?ticket=…`. */
  wsUrl: z.string(),
});
export type CollabTicket = z.infer<typeof collabTicketSchema>;

export const COLLAB_TICKET_AUDIENCE = 'collab';
export const COLLAB_TICKET_TTL_SECONDS = 60;

/** Claims of a collab ticket: a signed-in user (`sub`) or a guest with an EDIT link (`linkId`). */
export interface CollabTicketClaims {
  docId: string;
  /** User id; absent for guests. */
  sub?: string;
  /** Public link id; present for guests. */
  linkId?: string;
  /** Correlation id of the request that issued the ticket, carried into the collab logs. */
  correlationId?: string;
}
