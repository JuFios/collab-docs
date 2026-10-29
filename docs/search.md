# Search & index consistency

`GET /workspaces/:workspaceId/search?q=&limit=&cursor=` finds documents of a workspace by title and text. It is
for members only (a guest with a share gets `404`, like for every other workspace route), limited per user
(`RATE_SEARCH_PER_MIN_USER`, 60 a minute by default) and returns
`{ items: [{ id, workspaceId, title, snippet: [{ text, match }], updatedAt }], nextCursor }`, best match first. The web page is
`/workspaces/[workspaceId]/search?q=`: a Server Component behind a plain GET form, snippets drawn as text and `<mark>` elements
(never HTML), loading, empty and error states, and arrow-key navigation between the field and the results.

A guest of a document has no workspace to search, so `GET /me/shared-documents/search` searches the documents
shared with the caller directly, in any workspace (the same statement with the share as the scope instead of the
membership; same matching, paging and limit). The "Shared with me" page (`/shared?q=`) has the form; results link
into each document's own workspace.

**Why Postgres full-text search and not Meilisearch.** The data is already in Postgres, the volume is a few
thousand documents per workspace, and the one thing that must never be wrong is who may see a result. In SQL the
permission check is a join in the same statement, on the same snapshot, as the match; an external engine would
need the access rules copied into its documents and kept in step on every share, role or visibility change, and a
second service to run, back up and keep consistent. Meilisearch would give typo tolerance and better ranking
out of the box; at this size neither is worth a second source of truth. If the volume grew by two orders of
magnitude, the `search-sync` queue is the seam where an engine could be put in.

**Indexing is asynchronous.** Everything that changes searchable text announces `document.changed` after its
transaction commits: the collab service after a flush, the api after create, rename, delete and restore. The
`search-sync` job is debounced for 5 s (`SEARCH_DEBOUNCE_MS`; BullMQ deduplication, never `jobId = documentId`),
so a burst of edits is one run. The worker reads the **current** stored state of the document, not the event:

1. it reads `documents.revision`, then the CRDT state (`DocumentStateReader`), sanitises the content and extracts
   its text (`extractPlainText`; whitespace collapsed, control characters replaced, `<` stored as `\u0003`, at
   most 200 000 characters, because a `tsvector` is limited to 1 MB and a longer text would fail the job);
2. it upserts `document_search` with `WHERE indexed_revision < EXCLUDED.indexed_revision`, so a duplicate or a
   late job of an older run changes nothing. The revision is read before the state on purpose: if a flush lands
   in between, the text is newer than its stamp, which costs one more run; the other order could stamp a revision
   the text does not have, and the run for it would then be skipped for good;
3. it looks at the document once more: a deleted document loses its row, and if `revision` moved while the job was
   running, another run is queued. A thrown error is retried by the queue with backoff.

`document_search` holds `title`, `body`, `indexed_revision` and a generated `tsv`
(`setweight(to_tsvector('simple', cd_unaccent(title)), 'A') || setweight(…body…, 'B')`) with a GIN index, a
trigram GIN index on the title and a b-tree on `workspace_id`. `unaccent()` is `STABLE`, which Postgres refuses in
a generated column, so the migration pins the dictionary in `cd_unaccent(text)`, an `IMMUTABLE` wrapper; the query
applies the same function to its words. Each run logs `search.indexed` (with the lag of the change). The api's
`/metrics` exports `search_index_lag_seconds` (the age of the oldest change that is not in the index yet, `0`
when it is up to date) and `search_index_pending_documents`; they are read from the database when scraped, because
the worker process serves no endpoint, and a job that keeps failing shows up as a lag that keeps growing.

**Consistency.** The index is **eventually consistent**: a change is searchable roughly 5 s plus the job time
after it was stored, and a document just created is found by its title only after that too. **Permissions are
not part of the index.** Every request evaluates them in SQL: the caller must be a member, the document must not be
deleted, and it must be visible to them: owner/admin, the `EDITOR` who wrote it, a member of a
`visibility = WORKSPACE` document, or an explicit share (the same rules as `resolveDocumentAccess`, spec §4). So a
removed share, a restricted document, a deleted document or a removed member stops matching on the next request,
however far the index lags behind. The text of a result
comes from the index, the title from the document, so a rename shows at once in titles and is searchable after
the job.

**Query semantics.** The query is split into words (`[\p{L}\p{N}]+`, at most 8 words of at most 50 characters);
nothing else reaches the `tsquery`, and the words are bound parameters of a `Prisma.sql` statement (no string
is built from user input). Every word is a prefix term and all are required (`a:* & b:*`), ranked with
`ts_rank_cd` (title above body), ties broken by id, paged with a keyset cursor (rank, id). Highlights come from
`ts_headline`, which marks matches with the control characters `\u0001` and `\u0002` that cannot occur in the
indexed text; the api splits on them and the client renders the parts. The Postgres parser reads `<div>` or
`<script ...>` as an HTML tag and drops it from both the vector and the headline, so the indexed text keeps `<` as
the control character `\u0003` (a word separator to the parser), and the api turns it back into `<` in the
snippet: text in angle brackets, such as code, is found and shown as written.

| Language / input                  | Behaviour                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latin with diacritics             | Case and accents are ignored both ways: `cafe` finds `café`, `CAFÉ` finds `cafe`; `straße` and `strasse` are the same.                                                                                                                                                                                  |
| Ukrainian and Russian             | Case-insensitive prefix matching. There is no stemming (Postgres has no Ukrainian dictionary), so `документ` finds `документи` but not the other way round. `ё` folds to `е`, but `й` and `ї` are separate letters in the unaccent rules: `їжак` does not find `ижак`, and `йшов` does not find `ішов`. |
| Typos                             | Not corrected. The trigram index on the title is in place for a `similarity()` fallback (not wired up).                                                                                                                                                                                                 |
| E-mail addresses, URLs, `foo-bar` | Postgres' parser keeps an address or a URL as one token: `john` finds `john@example.com`, `example` does not. A hyphenated word is indexed whole and in parts.                                                                                                                                          |

The `simple` configuration is used on purpose: it needs no per-language setup, works for the mixed English and
Ukrainian content the product is meant for, and never drops a word as a stop word. Highlighting reads the
original text again, so `ts_headline` uses a text search configuration `cd_headline` (`simple` plus the
`unaccent` dictionary, the arrangement the `unaccent` documentation shows) to mark `café` for `cafe`.

**Operations.** `pnpm --filter @collab-docs/api build && pnpm --filter @collab-docs/api reindex -- --workspace=<id>`
(or `--all`) rebuilds the rows from the stored documents and drops those of deleted ones; with Docker:
`docker compose exec api node dist/scripts/reindex.js --workspace=<id>`. Run it with `--all` once after
upgrading (documents that existed before the index have no row, and the lag metric shows them as pending), after a
change of the text extraction (such as the `<` stand-in above; until then a document keeps its old row up to its
next change), or to repair an index after a Redis loss (a job that could not be queued is logged and counted in
`queue_enqueue_failures_total`; the document is then indexed with its next change).

**Query plan.** For a prefix query Postgres has no better estimate than a fixed share of the table, so on a
small table it rightly prefers the b-tree on `workspace_id` or a sequential scan. The tests check that the match
can be answered from the GIN index (the planner uses it when sequential scans are disabled) and that no
step of the statement hides the column from it.
