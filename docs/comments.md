# Comments & notifications

Threads of comments are anchored on a block of a document, people are mentioned with `@`, and a mention becomes an
in-app notification (pushed live over SSE) and an email. All routes are under `/api`:

| Route                                                   | Needs on the document     | What it does                                                                                     |
| ------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /documents/:id/threads?status=open\|resolved\|all` | view                      | Threads, oldest first, each with its comments; `orphaned` marks a thread whose block is gone.    |
| `POST /documents/:id/threads { blockId, body }`         | comment                   | Starts a thread and its first comment.                                                           |
| `POST /threads/:id/comments { body }`                   | comment                   | Replies.                                                                                         |
| `PATCH /comments/:id { body }`                          | comment, and author       | Edits (author only); sets `editedAt`.                                                            |
| `DELETE /comments/:id`                                  | view, and author or admin | Deletes; the author, or an owner/admin of the workspace.                                         |
| `POST /threads/:id/resolve`, `…/reopen`                 | comment                   | Idempotent.                                                                                      |
| `GET /documents/:id/mentionable?q=`                     | comment                   | People who can view the document, by the start of a name or an email; at most 10 (the `@` menu). |
| `GET /notifications?limit=&cursor=&unread=`             | (own)                     | The caller's notifications from every workspace, newest first, keyset-paged.                     |
| `GET /notifications/unread-count`                       | (own)                     | The number the badge shows; counts exactly what the list would show as unread.                   |
| `POST /notifications/read { ids } \| { all: true }`     | (own)                     | Marks as read; ids that are not the caller's are ignored.                                        |

"Comment" is the access level between view and edit of the permission model: editors, admins and owners have it,
viewers do not (a viewer reads the threads and gets `403` when writing), and neither does a guest on an edit link.
A guest with an `EDITOR` share has it. Routes that carry a thread or comment id resolve the document from the row
and check access on **that** document, again inside the write transaction, so an id from another workspace, a
restricted document the caller cannot open, a revoked share and a document in the trash are all `404`, the same
as for a document id. A malformed id is `400`.

**Body.** Plain text of 1 to 4000 characters, trimmed. It is never interpreted as HTML: the api returns it as
written, clients draw it as text, and the email escapes it. A mention is the token `@[<user id>]`, which the client
inserts when a name is picked from `mentionable`; anything else after an `@` is text.

**Mentions.** The server parses the tokens (well-formed ids only, each user once, at most 20), and keeps those whose
user exists **and may view the document** (the same predicate as search, evaluated in SQL: owner/admin, or a
workspace member of a workspace-visible document, or a share). A mention of anyone else would tell them the title
and an excerpt, so it is dropped: the token is removed from the stored text and the response lists it in
`warnings` (`MENTION_IGNORED`, or `MENTION_LIMIT` over the cap). A comment that is nothing but refused mentions is
rejected as empty. The kept mentions are stored in `comment_mentions` and returned with names, so a client never
has to resolve an id. Mentioning yourself is allowed and notifies nobody.

**Notifications.** In the same transaction as the comment, every mentioned user except the author gets a row with
`type = MENTION`, a payload (workspace, document and its title, thread, comment, author, an excerpt of the text as one
line) and `dedupe_key = comment:<commentId>:<userId>`. Creation is `INSERT … ON CONFLICT DO NOTHING`, so saving a
comment again, an edit that keeps a mention, or a retried request notifies nobody twice; an edit that adds a
mention notifies only the new person, one that removes a mention withdraws that person's notification, and what
was read stays read. Deleting a comment removes its notifications (they quote it). After the commit the api
publishes `notification.created { notificationId }` to the recipient's personal channel, and queues the email.
The list, and the unread count, hide a notification whose document the user can no longer open (revoked share,
restricted, deleted); it comes back if they get access again. Notifications keep a snapshot of the title and the
excerpt, so they read correctly even if the document is renamed.

**Live events.** `notification.created` travels on the SSE connection a tab already has open
(`GET /events/stream?workspaceId=`), which carries the workspace's `tree.changed` events and the user's personal
events from **every** workspace. The Redis envelope is addressed to a user id and the stream filters on it, so only
the recipient receives it, whichever workspace tab they have open. It carries the id only; the client refetches
the count or the list, which is where the access rules apply.

**Email.** One `mail` job per notification (`jobId = mention-<notificationId>`, so enqueueing twice is one job; the
id is never reused, unlike a per-document id). The worker renders the email when it runs, from the stored
notification: a notification that was deleted meanwhile, or whose recipient lost access to the document, sends
nothing. Names, title and excerpt are HTML-escaped in the HTML part and the subject cannot carry line breaks. It
links to `/workspaces/<workspace>/documents/<document>?thread=<thread>`. SMTP failures retry with the queue's backoff; sending
is at-least-once, so a crash between SMTP and the acknowledgement can repeat an email. There is no per-user "do
not email me" setting. A job that could not be queued is logged (`mail.enqueue_failed`) and counted in
`queue_enqueue_failures_total`; the notification itself is stored and listed regardless.

**Orphaned threads.** The text of a document lives in the CRDT state, not in a table, so a block cannot be a foreign
key. On every list the api reads the stored state (`DocumentStateReader`), collects the block ids
(`extractBlockIds`) and marks the threads whose block is absent as `orphaned: true`; an unreadable state leaves
the flags off instead of failing the list. Creating a thread does **not** require the block to exist in the
stored state, because that state trails the editor by a few seconds and a comment on a paragraph typed a moment
ago must not be refused; such a thread shows as orphaned until the next flush.

**Deleting.** A deleted comment keeps its row with an empty body (so a thread with replies keeps its shape and
shows a placeholder), its mentions and notifications are removed, and a thread whose comments are all deleted is no
longer listed.

**Limits and observability.** Writes are limited per user (`RATE_COMMENT_PER_MIN_USER`, 30 a minute by default),
because every mention is an email. Logs: `notification.created`, `mail.sent`, `mail.failed`, `mail.skipped`
(with the reason); `/metrics` has `notifications_created_total{type}` (the worker serves no endpoint, so its mail
results are in the logs and in `queue_jobs_processed_total` of the queue).

Not done: mentions in the **body** of a document (the editor has no suggestion menu for them yet, and a per-document
`dedupe_key = doc:<documentId>:<userId>` plus a queue on `document.changed` would be the way), per-user email
settings, digest emails, notifications for replies in a thread the user took part in, and editing a comment as an admin.
