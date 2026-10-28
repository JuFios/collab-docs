# Documents, caching and content

## Documents & hierarchy

Documents form a tree per workspace (`documents.parent_id`); siblings are ordered by a fractional-indexing key
in `documents.position` (`COLLATE "C"`), so a reorder rewrites one row and never rebalances. Endpoints live in
`apps/api/src/documents`; every route that takes a document id declares `@DocumentAccess(...)`, and restore
(which must see deleted rows) resolves access itself.

- **Permissions are not inherited.** A child copies the parent's visibility and shares when it is created and is
  independent afterwards. The consequence is a tree with holes: `GET /workspaces/:id/documents/tree` returns a
  flat list filtered for the caller, and a visible document under a hidden parent is returned with
  `parentId: null` so the id of the hidden ancestor is never disclosed (`GET /documents/:id` does the same).
- **Move** needs `EDIT` on the document and the new parent, the same workspace, and no cycle (`409`). Creates,
  moves, deletes and restores in one workspace take the workspace row lock (`SELECT ... FOR UPDATE`), which also
  serialises the plan-limit check and makes a cycle from two racing moves impossible, including moves into the
  root where there is no parent row to lock.
- **Soft delete** marks the whole live subtree in one recursive statement and stamps every node with
  `deleted_root_id`, including descendants the caller cannot see. The trash lists the root of each deletion.
  **Restore** brings back exactly the nodes of that deletion (a child deleted earlier stays in the trash), needs
  room under the plan's document limit (`403 PLAN_LIMIT_EXCEEDED`), and returns the document to the root when its
  parent is still deleted. Only a deletion root can be restored; restoring a node that was deleted with its
  parent is `409`.
- **Sharing** is by email for registered users only (`404` for unknown addresses). A guest sees only the
  documents shared with them (`GET /me/shared-documents`), not the tree or the workspace. A share overrides the
  workspace role in both directions.
- **Recent documents** (`GET /workspaces/:id/documents/recent?limit=`, default 8, max 20) feed the dashboard:
  newest change first, visibility filtered in SQL so the limit applies to documents the caller may open.
- **Who may do what:** create `EDITOR`+ with `EDIT` on the parent; edit title/icon, move and delete `EDIT`;
  change visibility or manage shares `MANAGE` or `EDIT` as the author; restore Owner/Admin or the author.

## Caching & invalidation

The document tree is cached in Redis as `tree:{workspaceId}:{version}` (5 minute TTL as a safety net). Every
mutation that can change the tree (create, rename, move, delete, restore, visibility, share) commits first and
then increments `tree:ver:{workspaceId}`; the old entry is simply never read again. A reader that loaded the
database before a concurrent commit stores its result under the old version, so a stale tree cannot be
served after the bump. **Permissions are not cached**: the cache holds the unfiltered live rows and each request
applies the caller's role and shares (one small query) after reading it. If Redis is down the tree is read from
Postgres. Hits, misses and errors are exported as `tree_cache_lookups_total{result}`.

After the bump the api publishes on Redis:

| Channel / queue                                 | When                                          | Consumers                                                                     |
| ----------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `realtime.events` -> `GET /events/stream` (SSE) | tree changed                                  | browsers of that workspace                                                    |
| `perm.changed`, `doc.deleted`, `doc.restored`   | visibility/share change, delete, restore      | collab re-evaluates open sockets                                              |
| `public-revalidate` (3 s), `search-sync` (5 s)  | content, create, title, icon, delete, restore | page revalidation ([Publishing](publishing.md)), search ([Search](search.md)) |

Everything is published only **after** the transaction commits, so a rolled-back request (for example a
rejected plan limit) emits nothing. The queues are debounced with BullMQ `deduplication` keyed by document id
(never `jobId = documentId`, which would silently drop later changes); the job reads the latest state when it
runs. A failed enqueue is logged and counted (`queue_enqueue_failures_total`) but never fails the request.

`GET /events/stream?workspaceId=` is server-sent events: members only (`404` otherwise), a heartbeat every 25 s
that also re-checks membership, `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` so a
rewrite proxy does not buffer it. One connection per browser tab carries the workspace's `tree.changed` events
and the caller's personal events.

## Content model

`@collab-docs/shared/content` is the single definition of what a document may contain; the editor, the
publishing endpoints, search and comments all build on it, and it imports neither `/nest` nor `@collab-docs/db`.

- **Allowlist as data** (`schema.ts`): nodes `paragraph`, `heading` (1-3), `bulletList`, `orderedList`, `listItem`,
  `taskList`, `taskItem`, `image`, `codeBlock`, `hardBreak`, `mention`; marks `bold`, `italic`, `code`, `link`;
  each with its attributes. The editor configuration and the sanitiser read the same table.
- **Storage format**: a `Y.XmlFragment` named `content` inside the `Y.Doc`, the field the Tiptap Collaboration
  extension must be configured with (`field: 'content'`; its default is `'default'`). `yDocToContentJson` reads
  it with `@tiptap/y-tiptap`, the library Tiptap v3 itself uses, so the XML shape is the editor's own.
- **`sanitizeContent`** turns any JSON into a valid document: unknown nodes are unwrapped (their text survives
  as text), unknown marks and attributes are dropped, `link.href` must be an absolute `http`, `https` or `mailto`
  URL (everything else, including `javascript:`, `data:` and relative references, loses the link mark) and gets
  `rel="noopener noreferrer nofollow ugc"`, images keep only `attachmentId` (a UUID) and `alt`, code languages come
  from a list, control and bidirectional-override characters are removed, and depth, node count and text length
  are capped (the walk over hostile input is bounded too). Anything that leaves the server as content goes through it.
- `extractPlainText`, `extractMeta` (description of at most 160 characters, first image), `extractMentions` and
  `extractBlockIds` serve search, social previews, notifications and comment anchors.

The tests include an XSS corpus and a round trip ProseMirror JSON -> `Y.Doc` -> encoded update -> JSON.
