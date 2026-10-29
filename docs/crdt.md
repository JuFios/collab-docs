# Collaboration and CRDT persistence

## Collaboration service

`apps/collab` owns document content. A document is a `Y.Doc` held in a room while someone has it open; clients
exchange Yjs updates with the room over a WebSocket, and nothing else writes content. The wire protocol,
close codes and the `persisted` / `access` / `deleted` room events are specified in
[docs/collab-protocol.md](docs/collab-protocol.md).

- **Transport.** `ws/collab-ws.adapter.ts` extends Nest's stock `WsAdapter` (`@nestjs/platform-ws`) in two
  places so the gateway can take binary frames on `/ws/<documentId>`: upgrades are routed by path prefix
  (the stock adapter matches the exact path) and message handlers are not bound (the stock adapter expects JSON
  messages, the `y-websocket` protocol is binary). The server is `ws` + `y-protocols`, the client is
  `y-websocket`.
- **Authentication and permissions.** The api issues a 60 s ticket (`POST /documents/:id/collab-ticket`, at
  least `VIEW`, limited per user); collab verifies it and reads the document permissions **from the database**
  with the same pure resolver as the api (`resolveDocumentAccess`), so the ticket cannot carry stale rights. A
  user below `EDIT` is connected read-only: their updates are dropped before they touch the document.
- **Permission changes** reach open sockets through the Redis events of the api and a 60 s re-check
  (see the protocol document); downgrade, revoke and delete all take effect without a reconnect.
- **Hot path.** A client update goes through size and permission checks, `Y.applyUpdate` inside `try/catch`, a
  duplicate check, and out to the other sockets and the `DocumentStore`: no HTTP call, no database read.
- **Presence.** Cursors are relayed; the server sets `user.id`, `name` and `color` from the authenticated
  identity, so a client cannot impersonate anybody.
- **Limits** (env, defaults from the spec): 200 messages per 10 s per connection, 1 MB per update, 10 MB per
  document, 100 connections per document, 4 KB per presence state. Violations are rejected, counted and logged
  as `collab.update_rejected` without disturbing the other clients; a refused update is reported to its sender
  (room event `rejected`), which reloads the document from the server state.
- **Metrics** (`/metrics`): `collab_connections`, `collab_rooms`, `collab_updates_applied_total`,
  `collab_updates_duplicate_total`, `collab_updates_rejected_total{reason}`, `collab_rate_limited_total`,
  `collab_ws_close_total{code}`, `collab_access_changes_total{outcome}`, plus the platform metrics.
- **Internal port 4002** is a TCP microservice of the same application (`connectMicroservice`, so it shares the
  rooms and the store through one DI container), never published by compose; every message carries
  `INTERNAL_API_TOKEN` and the caller's correlation id.
- **Persistence.** Rooms talk to storage only through the `DocumentStore` interface (`load`, `enqueue`,
  `onPersisted`, `flush`, `release`, `close`); the Postgres implementation is described in the next section.

### Scaling the collab service

One instance is supported, deliberately: a document's room lives in the memory of one process, which makes
ordering and the `persisted` acknowledgement simple. To run several instances you would route every connection
for a document to the same instance (consistent hashing on the document id at the load balancer), or give every
instance a room per document and fan updates and awareness out between them over Redis pub/sub, with the stored
update log as the source of truth for a room that starts cold. Both need a decision about who persists and who
acknowledges, which is why the second is more work than it looks. The rest of the service is already
stateless: tickets are verified with a shared secret, permissions are read from Postgres, and permission events
arrive through Redis, which every instance would subscribe to.

## CRDT persistence strategy

A document is stored as a **log of Yjs updates plus one compacted state** (`document_updates`,
`document_states`), the shape a CRDT wants: updates are small, idempotent and commutative, so appending them in
any order reproduces the document, and the log is folded into a snapshot now and then so it stays short.

**Write path** (`PostgresDocumentStore`, collab):

1. A room hands every applied update to the store synchronously (`enqueue`); nothing waits for the database.
2. Updates are buffered per document and flushed when the document has been quiet for 1 s, and at the latest 5 s
   after the first buffered update however busy it is (`COLLAB_FLUSH_INTERVAL_MS`, `COLLAB_FLUSH_MAX_WAIT_MS`).
3. A flush merges the buffer with `Y.mergeUpdates` into **one row** (unique on `(document_id, sha256 of the
bytes)`, `ON CONFLICT DO NOTHING`, so a retried flush cannot insert twice) and, in the **same transaction**,
   does `revision = revision + 1, content_updated_at = now()`. A consumer that sees the new revision therefore
   finds the content.
4. After the commit the store tells the room, which sends `persisted {sv, saved}` to its clients, and
   (fire-and-forget) queues `document.changed` for search (5 s debounce) and page revalidation (3 s). A Redis
   outage is logged and counted, and editing continues.

**Failures.** If the write fails, the buffer is kept in order and retried with backoff (1, 2, 5, 10, then every
30 s); a room whose updates are not written is not unloaded, and loading a document first writes whatever the store
still holds for it. Shutdown (`SIGTERM`) flushes every buffer before the database connection is closed.

**Saved means durable.** `y-websocket` does not acknowledge updates, so after every flush — and when a client
repeats an update the room already has — the server reports the state vector of what is in the database and
whether everything it received is stored (`persisted {sv, saved}`). The event sent on connect carries only the
vector: the client's offline changes have not reached the room yet, so nothing there can acknowledge them. A state
vector does not move for a deletion, so the flag is what acknowledges one: the client keeps a local change unsaved
until an event says `saved: true`, and the vector settles edits the server has not received yet
(`stateVectorCovers` in `@collab-docs/shared`). A server that sends no `saved` counts as "not confirmed". The same
check gates publishing: "publish only saved changes".

**The loss window.** If the process is killed (`kill -9`, power) the server loses at most the updates buffered since
its last flush, up to 5 s. They are not lost for good while the author's tab is open: the browser keeps its `Y.Doc`
and, on reconnect, answers the server's sync step 1 with everything the server lacks. What cannot be recovered is
a tab closed inside that window, which is why the editor is designed to show "Saving…" until the server confirms
the local state is stored and to warn before the page is left with unsaved changes.

**Cold start.** `load` reads the compacted state and every log row with `id > last_update_id` in one
repeatable-read transaction (a compaction between two separate reads could otherwise hide rows), merges them and
hands the result to the room. A row that cannot be decoded is skipped, logged and counted
(`collab_bad_log_rows_total`); the room still opens with everything else.

**Compaction.** When the tail reaches 100 rows or 512 KB (`COLLAB_COMPACT_MAX_ROWS`, `COLLAB_COMPACT_MAX_BYTES`),
and whenever a room is unloaded, one transaction folds state + tail into a new state (`encodeStateAsUpdate`),
upserts `document_states` with the highest folded id and deletes the folded rows. Concurrency is handled with
a per-document advisory lock: compaction takes it exclusively, appends take it shared. Without that, an append
holding a lower `bigserial` id but committing later than a higher one could fall below `last_update_id` and be
deleted unseen. Two compactions at once just run one after the other. Ten thousand one-character updates leave at
most 100 rows (tested); `collab_compaction_*` metrics show duration and rows folded.

**Versions** (`document_versions`, whole document as one update):

| Kind          | Created                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `AUTO`        | by collab after a flush, at most every 10 min (`AUTO_VERSION_INTERVAL_MS`) and only if changed |
| `MANUAL`      | `POST /documents/:id/versions {label?}` (EDIT); collab is asked to flush first (2 s limit)     |
| `PRE_RESTORE` | automatically, before a restore replaces the content                                           |

`GET /documents/:id/versions` lists them, `GET .../:versionId` returns the content as **sanitised** ProseMirror JSON
for a preview. Retention (hourly job in the worker): 50 automatic snapshots per document and 100 snapshots in all;
automatic and pre-restore ones go first, manual ones are only limited when created (`409` at 100).

**Restore** (`POST /documents/:id/versions/:versionId/restore`, EDIT): the api checks access and hands the work to
collab (the `collab.restore` message on port 4002), because only the service that owns the live document can
change it safely. Collab loads the room if nobody has it open, writes its buffer, saves the `PRE_RESTORE` snapshot,
then replaces the children of the content fragment with clones of the version's in **one Yjs transaction** made by
the server and flushes. Connected clients receive it like any other update and converge; the edit history is not
rewritten, so a restore can itself be undone from the pre-restore snapshot. If collab is unavailable the api answers
`503` rather than pretend.

**Deleting a document while it is edited.** The api's `doc.deleted` event (or the `collab.close` message on port 4002)
makes collab write the buffer first, since restore needs the content, then send `deleted` and close the sockets with 4410.

Internal messages on port 4002 (TCP; `token` is `INTERNAL_API_TOKEN`): `collab.flush { documentId }` (answers
`{ revision }`), `collab.restore { documentId, versionId, userId }`, `collab.close { documentId }`. See
[docs/collab-protocol.md](docs/collab-protocol.md).
