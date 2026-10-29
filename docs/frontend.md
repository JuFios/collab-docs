# Frontend

`apps/web` is a Next.js 15 App Router application (Tailwind, shadcn/ui primitives on Radix, Geist fonts
bundled through npm so builds need no network).

## Server vs Client boundary

Server Component is the default: anything that reads data and needs no browser state. A Client Component
(`"use client"`) exists only where the browser is required, and each one is listed here with the reason:

| Client component                                                                                            | Why                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/providers.tsx`                                                                                  | TanStack Query provider and the toast outlet                                                                                                 |
| `components/auth/login-form.tsx`, `register-form.tsx`                                                       | `useActionState` (pending state, field errors) and a zod pass before the round trip                                                          |
| `components/user-menu.tsx`                                                                                  | Radix menu; the logout Server Action runs from its event handler                                                                             |
| `components/workspaces/create-workspace-form`, `rename-workspace-form`, `invite-form`, `accept-invite-form` | `useActionState` (pending state, field errors, plan-limit explanation) and a zod pass before the round trip                                  |
| `components/workspaces/members-table.tsx`, `pending-invites.tsx`                                            | Role selects, the remove confirmation and revoke call Server Actions from event handlers                                                     |
| `components/workspaces/leave-workspace-button.tsx`                                                          | Confirmation dialog; the action runs from an event handler, then navigation and refresh                                                      |
| `components/workspaces/workspace-switcher.tsx`                                                              | Radix menu; the current workspace comes from the pathname, the list arrives as typed props                                                   |
| `components/workspaces/workspace-nav.tsx`                                                                   | `usePathname` marks the active section                                                                                                       |
| `components/workspaces/use-action-feedback.ts`, `use-validated-action.ts`                                   | Hooks: success toast and plan-limit event; `useActionState` that runs the zod schema in the browser before calling the action                |
| `components/workspaces/workspace-provider.tsx`                                                              | Owns the tab's single SSE connection and hands the workspace role, the initial tree and the connection state to the sidebar                  |
| `components/documents/document-tree.tsx`, `tree-row.tsx`, `workspace-sidebar.tsx`                           | TanStack Query, drag and drop (pointer events), roving focus and keyboard handling; none of it exists on the server                          |
| `components/documents/document-shell.tsx`, `document-title.tsx`, `document-gone.tsx`                        | Debounced inline title, live refetch when the document is renamed or deleted elsewhere, restore button                                       |
| `components/editor/*`, `lib/collab/use-collab-connection.ts`                                                | The block editor, the WebSocket, presence, save status and version history: Yjs, ProseMirror and `navigator.onLine` are browser-only         |
| `components/comments/*`, `lib/comments/*`                                                                   | Thread panel, composer with the `@` menu and optimistic writes (TanStack Query); it works on the live editor instance                        |
| `components/editor/block-comments.ts`                                                                       | ProseMirror plugin: the markers beside blocks, their highlight and the shortcut; browser-only like the rest of the editor                    |
| `components/notifications/*`, `lib/notifications/*`                                                         | The bell (Radix menu, unread badge), the `/notifications` list and the toast for a pushed notification                                       |
| `components/content/content-renderer.tsx` (not a client component)                                          | Stateless render of sanitised JSON; usable from a Server Component (the public page) and from the version preview                            |
| `components/documents/trash-list.tsx`                                                                       | Restore runs from an event handler, then the server-rendered list is refreshed                                                               |
| `components/dashboard/block-boundary.tsx`                                                                   | Error boundaries must be class components; one per dashboard block                                                                           |
| `app/(app)/workspaces/[workspaceId]/error.tsx`                                                              | Error boundary of the workspace segment (keeps the navbar and workspace header)                                                              |
| `components/billing/checkout-button.tsx`, `cancel-subscription-button.tsx`, `use-action-runner.ts`          | Buttons call Server Actions from event handlers (a plain `<form>` has nothing to submit), then navigate through `useActionFeedback`          |
| `components/billing/awaiting-confirmation.tsx`                                                              | The only waiting piece of the flow: asks the server for a fresh render every 1.5 s, at most 30 times, until the webhook has changed the plan |
| `components/billing/plan-limit-dialog.tsx`                                                                  | Listens to the plan-limit window event, so it needs the browser; reads the member's role from the workspace context                          |
| `components/billing/mock-checkout-form.tsx`                                                                 | The three buttons of the payment page; each runs a Server Action from its handler                                                            |
| `components/ui/dialog`, `dropdown-menu`, `label`, `sonner`                                                  | Radix/Sonner primitives that need effects and event handlers                                                                                 |
| `app/error.tsx`                                                                                             | Error boundaries must be Client Components                                                                                                   |

Screens and where they render (everything not listed as a client island is a Server Component):

| Screen                                             | Renders in                                  | Why                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/workspaces`                                      | RSC page + client create form               | The list is a plain read; the form needs pending state and field errors. Redirects to the last opened workspace (`cd_ws` cookie, set by the middleware) unless `?all` is present                                                                              |
| `/workspaces/[workspaceId]` (dashboard)            | RSC, four async RSC blocks                  | Each block has its own `Suspense` + error boundary, so the shell and skeletons flush first and the blocks stream in independently                                                                                                                             |
| `/workspaces/[workspaceId]/settings`               | RSC page + client forms/tables              | Data is read on the server (admin-only, `ForbiddenState` otherwise); every mutation is a Server Action                                                                                                                                                        |
| `/workspaces/[workspaceId]/billing`                | RSC page + client buttons                   | Plan, usage, plans and invoices are read on the server (admin-only); upgrade and cancel are Server Actions; one small island polls while a webhook is pending                                                                                                 |
| `/mock-checkout/[sessionId]`                       | RSC page + client buttons                   | A public route like a hosted checkout; the session is read with `cache: 'no-store'`, the buttons are Server Actions                                                                                                                                           |
| `/invite/[token]`                                  | RSC                                         | Previews the invite on the server and branches on the session: sign in / register links, a mismatch warning, or the accept form                                                                                                                               |
| `/workspaces/[workspaceId]/documents/[documentId]` | RSC page + client shell and editor          | The page reads the document and its `myAccess` on the server (404 / `ForbiddenState`, and a "deleted" state that is looked up in the trash); the shell is a client island that owns the real-time connection, the title, presence, save status and the editor |
| `/workspaces/[workspaceId]/trash`                  | RSC page + client list                      | Plain read of what the caller may restore; Restore is a REST call followed by `router.refresh()`                                                                                                                                                              |
| `/notifications`                                   | RSC page + client list                      | The first page is read on the server and seeds the client query (`initialData`); from there the list is live (the stream, the bell and window focus refresh it) and pages in with a cursor                                                                    |
| `/shared`                                          | RSC                                         | Documents shared with the caller in any workspace; a guest opens one without the workspace frame                                                                                                                                                              |
| Navbar                                             | RSC shell + switcher/bell/user-menu islands | The workspace list and the unread count are fetched in the layout and passed down as typed props (the bell asks again itself if the count could not be loaded)                                                                                                |

**Dashboard streaming.** `app/(app)/workspaces/[workspaceId]/page.tsx` awaits nothing but the workspace the layout already loaded
(deduplicated by `React.cache`). The blocks (`components/dashboard/blocks.tsx`: recent documents, members,
plan and usage, shared with me) are async Server Components under their own `<Suspense>`, so a slow or failing
block never holds back the others. The e2e suite asserts this on the raw response: with
`DASHBOARD_BLOCK_DELAY_MS` set (ignored when `APP_ENV=staging`) the first flush contains the skeletons and not
the data, and the data arrives later in the same response.

## Document tree and live updates

The sidebar of every `/workspaces/[workspaceId]/…` page is a Client Component fed by a Server Component: the layout fetches the flat
tree (`GET /workspaces/:id/documents/tree`) next to the workspace and passes it as `initialData` of the TanStack
Query that owns it, so the first paint already has the tree and no skeleton flashes. If only that fetch fails,
the sidebar loads the tree itself (skeleton, then a retry button). Everything else is the same query: the
document page reads breadcrumbs from it, and mutations update it.

- **Structure.** The api returns a flat list; `lib/documents/tree.ts` groups it by parent, orders siblings by
  their fractional position and flattens the open branches into visible rows. A node whose parent is not in the
  list (the api sends `parentId: null` under a parent the caller cannot see) is a root.
- **Moving.** A drop (pointer) or an `Alt+Arrow` (keyboard) is turned into the body of `POST /documents/:id/move`
  by pure functions in `lib/documents/move.ts` (`planDrop`, `planKeyboardMove`): which parent, and which sibling
  it goes before or after. They check what the api checks (EDIT on the node and on the new parent, no cycle into
  its own subtree) and drop moves that change nothing. The pointer position maps to a zone of the row under it:
  upper quarter = before, middle = inside, lower quarter = after (after an open parent = its first child). The api
  stays the source of truth: a refused move rolls the cache back to the snapshot taken before the optimistic
  update, and every settled mutation refetches.
- **Ordering of writes.** All tree mutations of a workspace share a mutation `scope`, so they reach the api one
  after another in the order the user made them; otherwise quick successive keyboard moves would be parallel
  requests that the server could apply in a different order than the one on screen.
- **Keyboard.** The tree is an ARIA tree with a roving tab stop: `↑ ↓ Home End` move focus, `→ ←` open, close or
  step to the child or parent, `Enter` opens the document, `F2` renames, `Delete` asks before moving to the
  trash, `Shift+F10` or the context-menu key opens the row menu, and `Alt+↑ ↓` reorder, `Alt+→` indents under the
  previous sibling and `Alt+←` outdents. Drag and drop itself is pointer-only (`@dnd-kit/react`, grip handle on
  every row the caller can edit); the keyboard path does not need pointer geometry.
- **Open branches** are remembered per workspace in `localStorage` (guarded with try/catch: private mode just
  forgets). The first render uses only the ancestors of the open document, so the markup matches the server's;
  the remembered set is merged right after mount.
- **Live updates.** `WorkspaceProvider` mounts the tab's only `EventSource` on `GET /api/events/stream`
  (`lib/realtime/event-stream.ts`). A `tree.changed` event invalidates the tree, the trash and every open
  document query. While the connection merely drops, the browser's own retry applies; when the browser gives up
  (a 401 closes an `EventSource` for good), the session is refreshed and a new source is opened with exponential
  backoff (1 s to 30 s). After any interruption the stream asks for a refetch, since events in between are gone.
  The sidebar shows the state (`Live`, `Connecting…`, `Reconnecting…`, `Offline`). Other features subscribe
  through the provider instead of opening a second stream (`notification.created` uses the same connection).
- **Permissions in the UI** only hide or disable what would be refused (`myAccess` per node, the workspace
  role): no drag handle, "+" or menu on read-only nodes, no title field for a reader (a "Read-only" badge
  instead). The api checks every request again.
- **Deleted and unavailable documents.** The api answers 404 for both. A member's trash lists what they may
  restore, so the document page and the open shell look the id up there: found means "This document was
  deleted" with Restore, otherwise "no longer available". A guest (a user with a share but no membership)
  opens `/workspaces/[workspaceId]/documents/[documentId]` without the workspace frame: the layout renders its children bare when the user is
  not a member, and every other page of the segment answers 404 through `requireWorkspace`.

## Editor & real-time client

The document body is edited with Tiptap on top of the `Y.Doc` that the collab service synchronises (`field:
'content'`). Everything that touches the connection lives in one hook, `useCollabConnection(documentId)`
(`lib/collab/use-collab-connection.ts`): it is the only place that creates a `WebsocketProvider` and the only
place that interprets a close code (`lib/collab/errors.ts`).

**Schema.** `components/editor/extensions.ts` expresses the content model of `@collab-docs/shared/content` as
Tiptap extensions: StarterKit without history, strike, underline, quote and rule (the sanitiser would remove
them from every published page, so the editor does not offer them), headings 1-3, task lists, a block `image`
that stores an attachment id and alt text only, a code block with a language picker, the `mention` node (rendered,
no suggestion UI yet) and `UniqueID` for block ids. `extensions.test.ts` builds an editor from the list and fails
if its node and mark names, or any node attribute, differ from the model. Undo and redo are the Yjs UndoManager's
(only the user's own changes), not ProseMirror history.

**Connection lifecycle.**

| Event                     | Behaviour                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mount                     | `POST /documents/:id/collab-ticket`, then `new WebsocketProvider(wsUrl, docId, ydoc, { params: { ticket }, disableBc: true })`; cross-tab sync is off so every update goes through the server, which owns permissions |
| Close 4401 (ticket)       | Fetch a new ticket, set `provider.params.ticket`, `provider.connect()`; gives up after five failed rounds in a row and offers "Try again"                                                                             |
| Close 4403 / 4404 / 4410  | `provider.disconnect()`; the editor is replaced by an access-denied, not-found or deleted screen. Room event `deleted` is handled the same way                                                                        |
| Close 4429                | Back off (1 s, 2 s, 4 s ... 30 s) before asking for a new ticket                                                                                                                                                      |
| Any other close           | Left to `y-websocket`'s own reconnect loop; a ticket that expired meanwhile ends in 4401 above                                                                                                                        |
| Ticket request fails      | 403 / 404 stop with the same screens; 429, 5xx and network errors back off, other errors stop with "Could not connect"                                                                                                |
| `access` event, downgrade | A client that could edit and now cannot discards its `Y.Doc` and starts a new session from the server state (a warning toast says whether unsaved edits were dropped); an upgrade rebuilds the editor as editable     |
| `rejected` event          | The server refused a local change: the client discards its `Y.Doc` and starts a new session from the server state, and a warning toast says the change was undone                                                     |
| `persisted` event         | Recomputes `hasUnsyncedChanges` (below)                                                                                                                                                                               |

The hook returns `{ ydoc, provider, status, synced, hasUnsyncedChanges, accessLevel, error, retry }`.
`y-websocket` 3.x already treats close codes 4400-4499 as final and reports them through its `closed` event
instead of reconnecting forever; the hook still calls `disconnect()` on the final codes and uses `connect()` for
the two it recovers from.

**Why "Saved" rests on `persisted`.** A WebSocket send succeeding says nothing about the database, and
`y-websocket` has no acknowledgements. The server therefore announces, after every flush and when a client
repeats an update it already has, the state vector of what is durable and whether everything it received is
stored (`saved`); the event on connect carries only the vector, since the client's offline changes are still on
their way. A state vector cannot show a deletion, so the client keeps a local change unsaved until an event says
`saved: true`; the vector then settles edits the server has not received yet. A server that sends no `saved`
counts as "not confirmed". The indicator
(`lib/collab/save-status.ts`) is derived from that and from the connection, so it cannot claim more than the
server confirmed:

| Indicator                                  | When                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `Connecting…`                              | Before the first sync of this session                                                                        |
| `Saving…`                                  | Connected and synced, but the server has not confirmed the latest local change (or the title is being saved) |
| `Saved`                                    | Connected, synced, every local change confirmed by `persisted {saved: true}`, title saved                    |
| `Offline — changes will sync on reconnect` | `navigator.onLine` is false or the socket dropped after it had been open                                     |
| `Could not save`                           | The title request failed                                                                                     |

Readers (Viewer, or EDIT revoked) see only the connection states, never "Saved". Edits made while offline stay
in the in-memory `Y.Doc` and merge on reconnect; nothing is kept in IndexedDB, so closing the tab while offline
loses them. `beforeunload` asks for confirmation while `hasUnsyncedChanges` is true. The same flag is what the
publishing flow will use to refuse "publish with unsaved changes".

**Presence.** The awareness state is written by the server (`user` is replaced with the authenticated identity),
so names and colours are trustworthy. Remote cursors and selections are drawn by `CollaborationCaret` with a
renderer that builds DOM from text nodes only and accepts nothing but a hex colour. The header shows one avatar per
other participant; viewers see presence too.

**Images.** A file chosen from the toolbar or slash menu, dropped on the editor or pasted as a bare image goes
`presign` -> `POST` to the bucket (multipart, with progress through `XMLHttpRequest`) -> `complete`; only then is
an `image` block inserted. The block reads the picture through `GET /attachments/:id/url` and refreshes the signed URL
shortly before it expires. Type, size and quota failures are ordinary mutation errors and reach the shared handler
(toast, or the plan-limit event).

**Version history.** The History button opens a panel next to the editor: automatic and saved versions, "Save
version" with an optional name, a read-only preview rendered by `ContentRenderer`, and "Restore" (confirmation,
EDIT or better). The collab service applies a restore as an ordinary edit after saving a `Before restore`
version, so the open editor, and every other client, converges through the CRDT without a reload.

**Known limitation.** If two people type their very first characters into the same empty block at the same
moment, one character can end up duplicated in both copies. It reproduces with stock Tiptap `Collaboration` and no
other extension (`@tiptap/y-tiptap` creating the first text node of an empty paragraph on both sides), so it is not
specific to this editor's configuration. Once the block has any text, concurrent typing in it merges exactly; the
two-editor e2e spec seeds the block first for that reason.

`ContentRenderer` has no `"use client"`: it renders sanitised JSON (and checks link protocols again), and takes a
`resolveImageSrc(attachmentId)` callback so that the editor can use signed URLs and the public page `/media/:id`.

## Comments and notifications in the UI

**Where things live.** The comments panel and the bell are Client Components because they are made of browser
state (a live editor instance, a caret, an `EventSource`); everything they show comes from the api through
TanStack Query with the zod schemas of `@collab-docs/shared`. Comment text is only ever put on the page as React
text nodes (there is no `dangerouslySetInnerHTML` anywhere near it), so `<img onerror=…>` typed into a comment
is displayed literally; a unit test and an e2e test pin that down.

- **Panel.** `CommentsPanel` sits beside the editor, in the place the version history uses (one side panel at a
  time). Threads are grouped by the block they are about; the group title is the block's first words, taken from
  the live editor document, and a click on it scrolls to the block and flashes it. Threads whose block is gone
  (`orphaned`, from the api) have a section of their own, resolved threads are hidden until "Show resolved
  threads" is on (a resolved thread that something links to is shown anyway), and a person without comment
  access sees every thread and a one-line explanation instead of the composer, reply boxes and Resolve buttons.
  The list is one query for the whole document (`status=all`), so the filter is instant and the block markers can
  count open threads without a second request.
- **Markers in the editor.** `BlockComments` (`components/editor/block-comments.ts`) is a ProseMirror plugin that
  draws a widget decoration beside every text block and image that has an id (`UniqueID`): a count of the open
  threads when there are some, otherwise an "add comment" button that appears on hover. The extension list of an
  editor must not change while a document is open (a new list rebuilds the editor and loses the caret), so the
  changing data (counts, may-comment, highlighted block) travels through a small controller object that the page
  updates and the plugin subscribes to, not through options. Lists around items are skipped so that a list item is
  not marked three times. `Ctrl/⌘+Alt+M` starts a thread on the block with the caret; markers without threads are
  not tab stops (a stop per paragraph would make the page unusable by keyboard), which is what the shortcut is for.
- **Composer.** A textarea (`role="combobox"` with the list-box pattern: `aria-controls`, `aria-activedescendant`,
  `↑ ↓ Enter/Tab Esc`). Typing `@` and a few letters queries `GET /documents/:id/mentionable`; picking a person
  inserts `@Name` into the text the user sees, and only names that were picked are turned into `@[<user id>]`
  tokens when the comment is sent (`serializeBody`), so text that merely looks like a mention stays text and two
  people with the same name are told apart by the order they were picked. Length is checked with the same zod
  schema as the api. `Ctrl/⌘+Enter` sends.
- **Optimistic writes.** New threads, replies and resolve/reopen follow the TanStack Query recipe: cancel the
  in-flight fetch, put the change into the cache, keep the previous list for a rollback, refetch when settled. An
  unconfirmed thread has an id starting with `pending:` and cannot be replied to. If the api refuses a comment the
  cache is rolled back and the composer gets its text back, so nothing typed is lost. Mentions the api dropped
  (the person cannot open the document) come back as `warnings` and are reported in a toast.
- **Links.** `/workspaces/:workspaceId/documents/:documentId?thread=:id` (in notifications and emails) is read by the document page on the server
  (validated as a uuid) and handed to the shell, which opens the panel, selects the thread and scrolls to its
  block once the editor is ready. A thread written after the page loaded is looked for with one extra fetch before
  the page says it is gone.
- **Focus and ARIA.** Opening the panel moves focus to its heading (or to the composer when a thread is being
  started), `Esc` closes it and hands the focus back to the "Comments" button, threads are `<li>`s in labelled
  lists, a thread's comments are an ordered list with `<time>` elements, and the autocomplete announces how many
  people it found.
- **Bell and list.** The unread count is read in the app layout and passed to the bell as `initialData`, so the
  badge is right in the first paint. A `notification.created` event arrives on the workspace stream that
  `WorkspaceProvider` already owns (there is no second connection): the provider refreshes the badge and any list
  on screen and shows a toast with the author, the document and an Open action. Outside a workspace (`/workspaces`,
  `/shared`, `/notifications`) no stream is open, because the api requires a workspace for it; there the badge is
  refreshed when the window gets focus and by a 60-second poll, which also covers anything the stream missed. The
  menu shows the newest eight; `/notifications` pages through all of them with the api's cursor. Using a
  notification marks it read before navigation (optimistic, rolled back on failure), and so does "Mark all as read".

Not done: editing and deleting your own comment from the UI (the api has both), mentions in the body of the
document, live updates of other people's replies inside an open panel (they appear on the next refetch: window
focus, reopening the panel, or any action of your own), and per-user notification settings.

## Billing UX

**Pages.** `/workspaces/[workspaceId]/billing` (admin and owner; everyone else gets `ForbiddenState`) is a Server Component. It shows
the current plan and the end of the paid period, the usage as three meters (amber from 80%, red at the limit,
no bar for an unlimited figure), the three plans side by side and the invoices. The plan catalogue comes from
`@collab-docs/shared`, the same table the api enforces, so the numbers on the cards cannot drift from the limits.
The settings page repeats the meters for a quick look. Banners cover the states of a subscription: waiting for a
confirmation, a declined payment, a canceled subscription and a workspace that is over the limits of its plan after
a downgrade. A workspace has no `past_due` state because the mock provider cannot fail a renewal (it has none), so
there is no banner for it.

**Paying.** Upgrade runs a Server Action that creates the checkout session and returns the payment page the api
points at; the button then navigates (`useActionFeedback`, see above for why the action does not `redirect`).
`/mock-checkout/[sessionId]` looks like a small hosted checkout. It is public, like the page of a real provider, and
the session id is the credential. "Pay" and "Fail payment" call the provider's endpoints from a Server Action, which
also reads the session again so that the page the user returns to comes from the provider's data. "Pay and re-send
webhook" pays and then asks the provider to deliver the same event a second time; it shows the idempotency of the
webhook on screen, is a development aid and is not offered when `APP_ENV=staging`.

**Waiting for the webhook.** The provider answers at once, but the plan changes when the webhook has been applied,
which goes through two queues and takes a few seconds (longer while a delivery is being retried). The user comes back to
`/workspaces/[workspaceId]/billing?awaiting=PRO`; a small client island calls `router.refresh()` every 1.5 s, at most 30 times, until
the server renders the expected plan, then toasts and removes the query string. After that it stops and offers
"Check again" instead of polling forever. Cancelling works the same way, waiting for `FREE`. A declined payment
comes back as `?payment=declined` and needs no waiting: nothing changes.

**Limits everywhere.** A create that hits a plan limit never shows a generic error. REST mutations (new document,
restoring from the trash, image upload) reach the shared error handler, Server Actions (invite) return the details in
`ActionState`; both fire the same window event, and `PlanLimitDialog` (mounted once in the workspace frame) shows the
limit, the figures and the plan. Admins and owners get "Upgrade plan" (a link to the billing page, hidden on the
largest plan); everyone else is told to ask an admin. The invitation form also keeps its inline explanation.

Not done: the 80% warning is shown on the meters but nothing warns before the action that would cross it, and the
dialog does not offer to free space (it only says so).

## Server Actions vs REST vs WebSocket

| Operation                                                                                                                      | Channel               | Why                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Create/rename workspace, invite, change role, remove member, revoke/accept invite, checkout, cancel subscription, login/logout | **Server Actions**    | Forms that work as plain `<form action>`, cookies handled on the server, `revalidatePath` refreshes the Server Components that show the data |
| Document tree (move/create/rename/delete), comments, sharing, publishing                                                       | REST + TanStack Query | Interactive, optimistic UI and cache invalidation in the browser                                                                             |
| Notifications, tree changes                                                                                                    | SSE                   | One-way push                                                                                                                                 |
| Document content, presence                                                                                                     | WebSocket (Yjs)       | Conflict-free merging and awareness                                                                                                          |

Server Actions call the api through `lib/api/server.ts` (cookies, `x-forwarded-for`, correlation id), validate
their input with the zod schemas of `@collab-docs/shared` (arguments of actions that are not form posts are
validated too, since they are public endpoints), and report failures as data (`ActionState`): field errors,
a plain-language plan-limit explanation (`PLAN_LIMIT_EXCEEDED` also fires the window event the limit dialog
listens to), or a generic message. Forms run the same schema in the browser first, inside the action
function (`use-validated-action.ts`), so field errors appear without a round trip. Authorization is always the
api's; hiding admin controls in the UI is convenience only.

**Why actions do not call `revalidatePath` or `redirect`.** The api client is never cached, so there is no server
data cache to purge; what a mutation needs is a fresh render of the current page. Calling `revalidatePath` or
`redirect` inside the action makes the action response carry that render, and on the production build (Next 15.5,
React 19.2) forms that did so intermittently stayed pending or never showed the result, with or without the nginx
proxy in front. Two things were measured: a `loading.tsx` above the workspace layouts made it much worse (6 of 16
submits of the invite form stalled, against 0 of 78 once the skeletons were scoped to their own segments, which
is why the list skeleton lives in the `app/(app)/workspaces/(list)` route group), but revalidating actions still flaked
in the parallel e2e run (create and rename, 2 of 4 runs). So an action only returns data (`ActionState`, including
`redirectTo` after creating a workspace or accepting an invite) and the component finishes the job in
`useActionFeedback`: toast, `router.push` when asked, and `router.refresh()`, a separate GET that also re-renders the
layouts (the navbar switcher picks up a new workspace). Components that call actions from event handlers (role
select, remove, revoke) refresh the same way. The root cause inside Next/React is not identified.

Route groups keep the rendering mode of each area separate:

- `app/(public)` — landing, `/login`, `/register`, `/invite/[token]`.
- `app/(app)` — everything behind a session (`/workspaces`, `/workspaces/[workspaceId]`, `/workspaces/[workspaceId]/settings`, documents, billing, notifications).
- The root `app/layout.tsx` is static: it never calls `cookies()` or `headers()`. Only `(app)/layout.tsx`
  reads the session, so public pages stay statically renderable (the build output marks `/` as static).

Three API clients, one per rendering context (all parse responses with the zod schemas of
`@collab-docs/shared`; there is no `any` at the boundary):

| Client              | Used from                 | Behaviour                                                                                             |
| ------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `lib/api/server.ts` | Server Components/Actions | Forwards the user's cookies, `x-forwarded-for`, `x-correlation-id` and `Origin`; never cached         |
| `lib/api/public.ts` | Statically rendered pages | No cookies, no headers (reading either would opt the page out of ISR); accepts `next.revalidate/tags` |
| `lib/api/client.ts` | Browser (TanStack Query)  | Same-origin `/api/*`; on 401 one single-flight `POST /auth/refresh`, one retry, then login            |

`/api/*` is a Next rewrite to `API_INTERNAL_URL`, so the browser only ever talks to its own origin: cookies,
the CSRF `Origin` check and SSE all work without CORS. The rewrite target is compiled into the build (Next
bakes rewrites into its routes manifest; the Dockerfile exposes it as a build arg), whereas
`JWT_ACCESS_SECRET`, `API_INTERNAL_URL` and `WEB_ORIGIN` used by the middleware and Server Actions are read at
request time — an image built without them works once they are set on the container.

**Edge middleware** (`middleware.ts`) is UX routing, not a security boundary: every Server Component, Server
Action and REST call is authorized again by the API. It verifies `cd_at` with `jose`, redirects anonymous users
off private routes, bounces signed-in users off `/login` and `/register`, and stamps `x-correlation-id`. The
refresh cookie is scoped to `/api/auth`, so the browser never sends it on a page navigation, and the access
cookie expires together with its JWT (an expired session looks like a missing cookie). For a private route
without a valid access token the middleware therefore redirects to `GET /api/auth/refresh?next=…`: the API
rotates the session and redirects back, or sends anonymous visitors on to `/login?next=…`. The routing decision itself is a pure function
(`lib/auth/route-policy.ts`).

Login and registration are Server Actions: zod on the client and again on the server, field errors from
`VALIDATION_FAILED`, a `Retry-After`-aware message on 429, and the API's `Set-Cookie` headers replayed through
`cookies().set` with identical attributes. `next` is only honoured for same-origin relative paths
(`sanitizeNextPath` in `@collab-docs/shared`, also used by the API redirect).

## Client address and the proxy

The API rate-limits logins, registrations and guest tickets per client address, taken from `X-Forwarded-For`
and honoured only from `TRUSTED_PROXY_CIDRS`. `web` forwards the header it receives, so whoever sets it
decides the address: an exposed Next server would let a client pick a new "IP" per request and defeat every
limit. Hence the compose topology `browser → proxy (nginx) → web → api`: nginx is the only published HTTP
port, replaces `X-Forwarded-For` with the peer address instead of appending to it, and passes `Host` and
`X-Forwarded-Proto`. It resolves `web` through Docker's DNS on every request (`resolver` plus a variable in `proxy_pass`), so recreating only the `web` container needs no nginx restart; the cost is a new upstream connection per request (no keepalive pool). The same holds for the staging override, which also unpublishes the api port.
If you put another load balancer or TLS terminator in front of nginx, configure nginx `real_ip` for it
(`set_real_ip_from` + `real_ip_header X-Forwarded-For`), otherwise every user shares the balancer's address.

## Error handling on the frontend

Every client turns a failed response into one `ApiError` (`status`, `code`, `message`, `correlationId`,
`fieldErrors`). Query and mutation failures pass through one handler (`lib/api/error-handler.ts`, wired into the
TanStack `QueryCache`/`MutationCache`):

| Case                  | Behaviour                                                                          |
| --------------------- | ---------------------------------------------------------------------------------- |
| 401                   | Client refreshes once and retries; if that fails the user is sent to `/login`      |
| 403 (query)           | No toast: the screen renders `ForbiddenState`                                      |
| 404 (query)           | No toast: the screen renders its not-found state                                   |
| 403 (mutation)        | Toast "You don't have permission to do that"                                       |
| `PLAN_LIMIT_EXCEEDED` | `plan-limit-exceeded` window event for the limit dialog (see Billing UX); no toast |
| 429, network, 5xx     | Friendly toast; the correlation id is shown as a reference                         |

`app/error.tsx` and `app/not-found.tsx` cover render-time failures; `EmptyState`, `ErrorState`,
`ForbiddenState` and `LoadingState` are the shared building blocks.

## Public pages: why ISR + on-demand revalidation

`/published/<slug>` is a page that many people may open and that changes rarely, so it is rendered once and served from
Next's cache (incremental static regeneration) instead of on every visit. Three alternatives were weighed:

| Option                             | Why not                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Render on every request (SSR)      | Every reader hits the api and the database; a popular page costs as much as a busy editor.                                              |
| Static export at publish time      | Needs a rebuild or a deploy per edit, which is what "the page follows the document" must avoid.                                         |
| Time-based ISR only (`revalidate`) | A change shows up after up to an hour, and an unpublished page keeps being served until then.                                           |
| **ISR + on-demand revalidation**   | The page is cached for an hour as a fallback; the api worker drops it within seconds of a change, a publish, an unpublish or an expiry. |

How it fits together:

- **Route.** `app/(public)/published/[slug]/page.tsx` is made of Server Components only and reads no `cookies()` or
  `headers()`; either would turn the route dynamic and the cache would be gone. `revalidate = 3600` and an empty
  `generateStaticParams` make every slug render on first visit and then be cached. The data comes from
  `GET /public/documents/:slug` through the anonymous client `lib/api/public.ts`, with the cache tag `pub:<slug>`
  (the slug is all the page knows before it has the document).
- **Invalidation.** The api worker (`public-revalidate` queue, debounced for content and title, immediate for
  publish, unpublish, expiry) calls `POST /internal/revalidate` with `x-revalidate-secret` and `{tags: ["pub:<slug>"]}`.
  The handler compares the secret in constant time, validates the body with the schema from `@collab-docs/shared`
  and calls `revalidateTag`. The reverse proxy does not forward `/internal/*`, so only the worker (which reaches the
  web container directly) can call it. If a call fails the queue retries with backoff; after that the hour-long
  fallback applies.
- **A cached 404 does not stick.** Next caches `notFound()` too. The page asks for its data under the same tag
  even when the answer is 404, so publishing a slug (or republishing an unpublished one) invalidates the cached
  "not found" the same way.
- **Safety.** The content that reaches the page is sanitised on the server, and the renderer builds React
  elements from it: there is no `dangerouslySetInnerHTML`, unknown nodes are skipped, every link is checked again
  and gets the forced `rel`. Images go through `/media/<id>?slug=`, which asks the api for a 5-minute signed URL and
  redirects, so a visitor never needs an account or a storage address.
- **Cost for the reader.** Client providers (TanStack Query, the toaster) live in the layouts of the route groups
  that need them, not in the root layout, so the published page downloads React and Next and nothing else.
  `pnpm --filter @collab-docs/web check:bundle` (a CI job) reads the build output and fails if `/published/[slug]` stops
  being ISR-capable or if the editor, Yjs or the query client appear in its JavaScript.
- **Edit links** (`/edit-link/<token>`) are the opposite case: personal, never cached, not indexed, `Referrer-Policy:
no-referrer`. The server shell checks the link and shows the expired, replaced or deleted state; the editor is the
  one from the app, with a ticket issued for the link, and without images (the attachments api needs a signed-in
  user).
- **Publishing waits for the editor.** The Share dialog enables "Publish to web" only when the editor is online,
  synced and has no change the server has not acknowledged (`persisted`); otherwise it says why. This is the
  "publish with unsaved changes" edge case.

`ISR_REVALIDATE_SECONDS` was removed: a route segment's `revalidate` has to be a literal, so the window cannot come
from the environment. A unit test keeps the page and the data fetch on the same value.
