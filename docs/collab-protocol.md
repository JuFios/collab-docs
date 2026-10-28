# Collaboration protocol

The collab service speaks the `y-websocket` wire protocol plus one extra message type for room events, so the
stock `WebsocketProvider` works against it. Everything below is what the server guarantees; the Tiptap editor
side builds on it.

## Connecting

1. `POST /api/documents/:id/collab-ticket` (cookie session, at least `VIEW`) returns
   `{ ticket, wsUrl }`. The ticket is a JWT (HS256, `aud=collab`, 60 s) with the document id and the user id. It
   only says who is asking: the collab service reads the permissions from the database when the socket opens, so
   a viewer receives a read-only connection from the same kind of ticket as an editor. `wsUrl` comes from the
   runtime variable `COLLAB_PUBLIC_URL` (`ws://host:4001/ws`). A guest with an edit link gets the same kind of
   ticket from `POST /api/public/links/:token/ticket`, carrying `{docId, linkId}` instead of a user id; the api
   has checked the secret, and the collab service resolves the link (`mode`, `revoked_at`, `expires_at`) from the
   database as it does for a user.
2. The browser opens `${wsUrl}/${documentId}?ticket=${ticket}`. `y-websocket` builds the URL from
   `provider.params` on every connection attempt, so the client refreshes `provider.params.ticket` before a
   reconnect. A ticket is checked once, at connect time; it is not a session.
3. The server verifies the ticket, loads the permissions, admits the socket to the document's room and sends the
   handshake: sync step 1, the presence of everybody in the room, an `access` event and a `persisted` event.

Port **4001** is public (`/ws/<docId>`, `/health`, `/ready`, `/metrics`). Port **4002** is the internal API (a TCP
microservice, see the end of this document); it is not published by compose and every message has to carry
`INTERNAL_API_TOKEN`.

## Messages

Binary frames; the first varuint is the message type.

| Type  | Name            | Direction | Payload                                                                                |
| ----- | --------------- | --------- | -------------------------------------------------------------------------------------- |
| `0`   | sync            | both      | `y-protocols/sync`: step 1 (state vector), step 2 (diff), update                       |
| `1`   | awareness       | both      | `y-protocols/awareness` update (presence)                                              |
| `2`   | auth            | —         | ignored                                                                                |
| `3`   | query awareness | client    | server answers with the current presence                                               |
| `100` | room event      | server    | `varString` of JSON, see below; register `provider.messageHandlers[100]` to receive it |

Text frames are ignored. A frame larger than `COLLAB_MAX_UPDATE_BYTES` (+ framing) makes the WebSocket layer
close the socket with 1009.

### Room events (type 100)

```json
{ "type": "persisted", "sv": "<base64 Yjs state vector>", "saved": true }
{ "type": "access", "level": "VIEW", "readOnly": true }
{ "type": "deleted" }
```

- **`persisted`** is sent after every flush of the document to storage, when a client repeats an update the room
  already has, and once when a client connects. The state vector covers everything that is durable. After a flush
  or a repeat, `saved` says that every update the room had received is stored too; the event sent on connect
  carries only `sv`, because the client's offline changes have not arrived yet and nothing there can acknowledge
  them. A state vector does not move for a deletion, so `saved` is what acknowledges one; a client treats a
  missing `saved` as "not confirmed", keeps its own changes pending until an event says `saved: true`, and drives
  its `Saved / Saving… / Offline` indicator from that. Publishing is allowed only when the server has confirmed
  everything as stored.
- **`access`** is sent on connect and whenever the permission of this socket changes. `readOnly` is true below
  `EDIT`. After a downgrade the client recreates its `Y.Doc` from the server state (local changes the server
  ignored are discarded, with a warning to the user).
- **`deleted`** precedes close code 4410.

## Presence

The awareness state is `{ user: { id, name, color }, cursor }`. The server **replaces `user`** with the
authenticated identity (the id of the signed-in user, `guest-<connection>` for a link guest, the name from the
database and a colour derived from the user id; guests are called `Guest 1`, `Guest 2`, … in order of arrival
at that room) and keeps only `cursor` from the client, limited to
`COLLAB_MAX_AWARENESS_BYTES`. A connection may only change the awareness client ids it registered first (at most
four) and never the server's own, so one client cannot move or remove another's cursor. When a socket closes its
presence is removed for everybody.

## Updates

Sync step 2 and update messages from a client are applied to the room's `Y.Doc` only if

- the connection has `EDIT` or better (otherwise ignored; counted and logged as `collab.update_rejected`),
- the update is at most `COLLAB_MAX_UPDATE_BYTES`, and applying it keeps the document under
  `COLLAB_MAX_DOCUMENT_BYTES`,
- it decodes and applies (applied inside `try/catch`; a corrupt update never reaches the other clients), and
- it changes the document. A duplicate or no-op update is neither stored nor broadcast
  (`collab_updates_duplicate_total`).

Accepted updates are forwarded to the other connections and handed to the document store; there is no HTTP or
database call on this path. A connection sending more than `COLLAB_MAX_MESSAGES_PER_10S` is closed with 4429.

## Close codes

| Code | Meaning                                                            | Client action                           |
| ---- | ------------------------------------------------------------------ | --------------------------------------- |
| 1009 | Frame too large                                                    | Do not resend; reconnect                |
| 4401 | Ticket missing, malformed, expired or for another document         | Fetch a new ticket and reconnect        |
| 4403 | No access (also: access revoked while connected, guest link ended) | `provider.disconnect()`; show a message |
| 4404 | The document does not exist (or the path is not a document id)     | `provider.disconnect()`                 |
| 4410 | The document was deleted                                           | `provider.disconnect()`; offer restore  |
| 4429 | Too many messages, or the document is at its connection limit      | Back off before reconnecting            |

`y-websocket` 3.x treats close codes 4400-4499 as final: it stops reconnecting and emits `closed`, and a later
`provider.connect()` resumes. Older versions reconnect forever on any close. The client therefore calls
`provider.disconnect()` on 4403, 4404 and 4410 (`COLLAB_FINAL_CLOSE_CODES` in `@collab-docs/shared`), which is
correct for either behaviour, and calls `connect()` itself after 4401 (with a new ticket) and 4429 (after a
pause). Every other code, 1006 included, is retried by the provider with its own backoff.

## Permission changes while connected

The api publishes `perm.changed`, `doc.deleted` and `doc.restored` on Redis after the transaction commits. The
collab service subscribes and re-reads the permissions of the affected sockets from the database: a downgrade
turns a socket read-only (and sends `access`), a grant makes it editable again, lost access closes it with 4403,
a deleted document is flushed, announced with `deleted` and closed with 4410. Every socket is also re-evaluated
every `COLLAB_ACCESS_RECHECK_MS` (60 s), which covers a lost Redis message. Revoking or replacing an EDIT link
publishes `perm.changed` (reason `link_changed`) for the document, and the job that runs when a link expires
does the same, so guests are cut off at once; the 60 s check remains the fallback.

## Rooms

A room is created when the first client connects (`DocumentStore.load`) and unloaded `COLLAB_ROOM_IDLE_MS` after
the last one leaves, after the store has written its buffer and compacted the log (a room that could not be
written stays loaded and is retried). `DocumentStore` is the only way a room touches storage; the Postgres
implementation is described in the README ("CRDT persistence strategy").

## Internal API (port 4002)

A TCP microservice of the collab application (`@nestjs/microservices`, request/response `@MessagePattern`s), not
published. Every message is an object with `token` (`INTERNAL_API_TOKEN`, compared in constant time) and, when the
caller has one, `correlationId`; the other fields are validated like an HTTP body. A failure is answered as an
error whose body is the usual error body (`statusCode`, `code`, `message`, `correlationId`), so a missing token is
`401`, an unknown document or version `404`, a malformed field `400`.

| Pattern                                            | Effect                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `collab.flush { documentId }`                      | Writes the buffered updates; `{ revision }`. 500 if the database refuses (the buffer is kept). |
| `collab.restore { documentId, versionId, userId }` | Snapshots the current content (`PRE_RESTORE`), replaces it with the version's; `{ revision }`. |
| `collab.close { documentId }`                      | Final flush, `deleted` event, close 4410 for every connection; `{ closed }`, idempotent.       |
| `collab.status`                                    | `{ rooms, connections }`.                                                                      |

The api waits 2 s for a flush (and carries on with the stored state if it gets none) and 15 s for a restore (`503`
when collab is unreachable, slow or fails).
