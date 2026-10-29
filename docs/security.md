# Security

Security is a set of layers, each with a test that fails when the layer is removed. This section lists them, what
each one protects against and where its test is.

| Layer                       | What it does                                                                                                                                | Test                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Authorisation on the object | every route resolves access from the database for the id it was given (no caching, see [Permission model](permissions.md#permission-model)) | `apps/api/src/security/idor.int.spec.ts`            |
| CSRF                        | `Origin` must be `WEB_ORIGIN` or one of `CORS_ALLOWED_ORIGINS` for cookie-authenticated unsafe requests (`CSRF_REJECTED`, 403)              | `e2e/tests/security.spec.ts`, auth suite            |
| Content-Security-Policy     | one static policy for every page, see below                                                                                                 | `apps/web/lib/security/headers.test.ts`, e2e        |
| Sanitiser and escaping      | content is reduced to an allowlist before it is shown, emails escape what users wrote                                                       | `apps/api/src/security/xss.int.spec.ts`             |
| Injection guards            | no string-built SQL, no HTML sinks; lint rules plus a scan of the sources                                                                   | `eslint.config.mjs`, `source-audit.spec.ts`         |
| Rate limits                 | per address and per user, counted before the access check                                                                                   | `apps/api/src/security/rate-limits.int.spec.ts`     |
| Collab limits               | message rate, update size, document size, connections, awareness                                                                            | `apps/collab/src/ws/security.int.spec.ts`           |
| Dependencies and secrets    | `pnpm audit --prod` in CI, placeholders only in templates, redacted logs                                                                    | CI job `audit`, `secrets.spec.ts`, `logger.test.ts` |

## Who may call what: the IDOR matrix

`idor.int.spec.ts` reads every operation of the OpenAPI document and calls it as nine personas: nobody, a signed-in
outsider, a viewer, an editor, an admin, the owner, a guest who was shared the document, and two visitors who only
hold a public link (one live, one expired). Document routes run twice, against a workspace-visible document and a
restricted one. The expected status is not written per persona but derived from a policy in
`idor-table.ts` (`document: EDIT`, `workspace: ADMIN`, …) with the rules of the permission model: no session → 401,
no access at all → 404 (existence is not disclosed), some access but not enough → 403. A route that is in the OpenAPI
document and not in the table fails the suite, and so does a table row without a route, so a new endpoint cannot ship
without a decision. Requests that change state get fresh resources for every persona, so one allowed call never alters
what the next sees. A second block swaps ids between tenants (a version, link, share, attachment, thread, member or
invite of another workspace used through a path of one's own) and expects 404 everywhere.

## Content-Security-Policy and headers

`next.config.ts` sends the same headers on every response (built in `lib/security/headers.ts`), with this policy:

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: <S3 origin>; font-src 'self' data:; connect-src 'self' <S3 origin> <collab origin>;
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
```

plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and a
`Permissions-Policy` that switches off camera, microphone, geolocation, payment and USB. In the staging profile the
middleware adds `Strict-Transport-Security` (browsers ignore it over plain HTTP). The two origins come from
`S3_PUBLIC_ENDPOINT` and `COLLAB_PUBLIC_URL`; Next compiles headers into the routes manifest, so like the api
rewrite they are build arguments of the web image (compose passes them on).

**Nonce on workspace pages.** Everything behind sign-in (the `(app)` routes: tree, editor, settings, search) is rendered
per request anyway, because the layout reads the session. For those paths the edge middleware generates a nonce per
request and sends a second policy whose `script-src` is `'self' 'nonce-<value>' 'strict-dynamic'` (no `'unsafe-inline'`);
it puts the same policy on the request, which is where Next reads the nonce from to mark its own scripts. A browser
enforces every policy it receives, so on these pages an injected inline script is refused even though the static
policy is sent too. The origins of the nonce policy are the same build-time values (`next.config.ts` passes them to
the middleware). The e2e suite checks that a workspace page has a fresh nonce on each load and that every script
carries it.

**Why not a nonce everywhere.** A nonce policy needs a fresh value in every response and in the `<script>` tags of that
response, which makes each page dynamic. The published pages (`/published/[slug]`) are ISR: they are rendered once and served from the
cache to everyone, and a per-request nonce would turn them back into server-rendered pages (the e2e suite checks that
the second request is still an `x-nextjs-cache: HIT` and that the header carries no nonce). The price of the static
policy is `'unsafe-inline'` for scripts, which Next's hydration data needs. What carries the weight instead: no
third-party origin is allowed anywhere, `object-src`, `base-uri`, `frame-ancestors` and `form-action` are closed, and
nothing user-written is ever rendered as markup (the sanitiser below). `script-src` gets `'unsafe-eval'` only in
`next dev`. The e2e fixture that signs users in also fails a test if the browser reports a policy violation, so a
feature that needs a new origin fails loudly.

## Middleware is not a boundary

The edge middleware decides redirects (sign in, refresh) so that a visitor does not see a page flash; it grants
nothing. Every page and every API call checks the session again where the data is read. The e2e suite sends
`x-middleware-subrequest` (the header of CVE-2025-29927, which told Next to skip middleware) with several values to
a private page and to the API and expects no page and no data, and posts from a foreign `Origin` (and with none) with a
valid session cookie and expects `CSRF_REJECTED`. Server Actions pass the visitor's address on to the API, so their
attempts count against the visitor's rate-limit bucket and not the web container's (see
[Client address and the proxy](frontend.md#client-address-and-the-proxy); the e2e suite shows that a form sign-in moves the same
bucket as a direct call).

## Injection and XSS

- **SQL.** Raw queries are tagged templates or `Prisma.sql`, so every value is a bound parameter. ESLint forbids
  `$queryRawUnsafe`, `$executeRawUnsafe`, `Prisma.raw` and untagged `$queryRaw(...)` calls with a string; `eval`,
  `new Function` and assigned HTML (`innerHTML`, `insertAdjacentHTML`, `document.write`) are forbidden too, and in the
  web app `react/no-danger` rejects `dangerouslySetInnerHTML`. Tests may use them (a test truncates tables by name).
  `source-audit.spec.ts` repeats the check over the production sources by text, so it also fails when someone turns a
  rule off with a comment.
- **Rendering.** Document content passes `sanitizeContent` (node and mark allowlist, link schemes `http`, `https`,
  `mailto`, no free-form attributes) before the published page, the version preview or any other reader gets it.
  Search snippets are lists of `{ text, match }` segments that React renders as text; emails escape every user-written
  value and keep line breaks out of the subject.
- **One hostile corpus, every path.** `xss.int.spec.ts` writes a document made of script and image tags, event
  handlers, `javascript:` / `data:` / obfuscated link targets, unknown nodes (`script`, `iframe`, `svg`, …) and
  attributes (`onerror`, `style`, `srcdoc`) and checks the result of the published page, a version preview, search
  and the two emails: only schema nodes and marks, no link with a hostile target, no attribute the schema lacks. The
  typed markup survives as inert text.

## Rate limits

| Preset         | Scope   | Default                                     | Routes                                                                 |
| -------------- | ------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `login`        | address | 20 / min (+ 5 / min per address and e-mail) | `POST /auth/login`                                                     |
| `register`     | address | 10 / h                                      | `POST /auth/register`                                                  |
| `guestTicket`  | address | 30 / min                                    | `POST /public/links/:token/ticket`                                     |
| `ticket`       | user    | 30 / min                                    | `POST /documents/:id/collab-ticket`                                    |
| `publicLink`   | user    | 10 / h                                      | `POST /documents/:id/public-links`                                     |
| `search`       | user    | 60 / min                                    | `GET /workspaces/:id/search`                                           |
| `comment`      | user    | 30 / min                                    | thread, reply and edit routes of comments                              |
| `mockProvider` | address | 30 / min                                    | pay, decline and re-send on the mock payment page                      |
| global         | address | 600 / min                                   | every other route (not the event stream and the operational endpoints) |

All of them are `@nestjs/throttler` guards over one Redis store; the per-address-and-email login counter is a
route-level guard (`LoginThrottlerGuard`) whose tracker is the address plus a hash of the normalised e-mail, and
it reports its counters as `X-RateLimit-Login-*` so they do not hide the per-address ones.

**Which address counts.** `req.ip` honours `X-Forwarded-For` only from `TRUSTED_PROXY_CIDRS`. In compose that is
exactly the proxy and the web container, which have fixed addresses in the compose subnet (`NETWORK_PREFIX`,
`10.89.0.10` and `.11`); the proxy overwrites the header, and web passes it on for its server-side calls. A
request to the api's published development port arrives from the network's gateway, which is not trusted, so a
spoofed header there changes nothing (`e2e/tests/client-ip.spec.ts` checks both ways in).

A refusal is `429` with `{ code: 'RATE_LIMITED', correlationId }` and a `Retry-After` header. `rate-limits.int.spec.ts`
reads the preset of every route from the Nest metadata and compares it with this table, then exhausts each limit
and checks the refusal, that another address or user behind the same address is not punished, and that the user
limits count a request even when the target does not exist. That last test found a fault: the user limits sat
_below_ the access decorators of three routes, and guards run in the order the decorators are applied, so a probe
of somebody else's id was refused by the access check first and never counted. The limit decorator now sits under
the access decorator on those routes (with a comment: the order is the behaviour).

## Collab abuse limits

| Limit                             | Default                     | Result                                |
| --------------------------------- | --------------------------- | ------------------------------------- |
| messages per connection           | 200 / 10 s                  | close `4429`                          |
| one update                        | 1 MiB (frame limit in `ws`) | close `1009`                          |
| a document                        | 10 MiB                      | further updates dropped, socket stays |
| updates waiting for a missing one | 1 MiB (the update limit)    | dropped, sender refused (`too_large`) |
| connections per document          | 100                         | close `4429` for the extra one        |
| awareness payload                 | 4 KiB                       | dropped                               |

`apps/collab/src/ws/security.int.spec.ts` provokes each of them with raw sockets (the limits are lowered by the suite's
environment), and checks that presence cannot be spoken for another client or carry an identity the server did
not assign, that every close reason is one of a fixed list of texts (no parser or JWT message ever reaches a client),
and that a socket without write access, fed hundreds of valid and mutated sync, step-2 and awareness frames, changes
nothing in the document while an editor on the same document keeps working. A guest is cut off at the moment their edit link
expires: every admission and every re-evaluation sets a timer for `expiresAt` (`AccessReevaluator.watchExpiry`),
so the cut-off does not wait for the periodic check (`COLLAB_ACCESS_RECHECK_MS`), which stays the safety net for a
link that was changed behind collab's back. `guest-expiry.int.spec.ts` turns the periodic check off and checks that
the socket is closed with `4403` when the link expires and that a late write is not stored. Revocation does not wait
either (collab is told at once).

## Caches follow the data

`cache.int.spec.ts` lists every route under `/documents` that changes something and says what it must do to the
caches: bump `tree:ver:{workspace}` (create, rename, icon, visibility, move, delete, restore, share, change and
remove a share) and/or ask for the published page to be rebuilt (title, icon, delete, restore, publish, unpublish; a
changed expiry plans the rebuild for the moment the link ends). A route that is not in the list fails the suite.

## Dependencies, secrets, logs

- CI runs `pnpm audit --prod` in its own job: production dependencies only, since an advisory in a dev tool does not
  ship. Advisories in transitive dependencies are patched with `overrides` in `pnpm-workspace.yaml` (currently
  `multer` and `js-yaml`, both pulled in by `@nestjs`).
- `.env.example` holds placeholders that contain `dev-only` (the services refuse them outside dev and test);
  `.env.staging.example` has every secret empty; the staging compose file requires each one with `${NAME:?…}` and
  has no defaults. `secrets.spec.ts` checks that, and scans the repository for the shapes of private keys, cloud and
  source-host tokens and signed JWTs.
- Logs redact `authorization`, cookies, `set-cookie`, the internal and revalidate headers, and the fields `password`,
  `token`, `accessToken`, `refreshToken`, `ticket`, `secret`, `authorization`, `cookie`, both as a field of the line
  and one level down (pino's `*.name` does not reach the top level, which is how the second form was missing).
- Invite and edit-link tokens travel in the URL path, so the request log of the api masks that segment
  (`/api/invites/[REDACTED]`) and leaves out query strings (`loggableUrl`), and the proxy's access log does the same
  for `/invite/…`, `/edit-link/…` and their api routes, without query string and `Referer`. nginx's error log still
  writes the request line when an upstream fails.

Audit findings fixed on the way: Yjs keeps an update whose dependencies have not arrived in memory without emitting
anything, so such updates were neither persisted nor counted towards the document size, and the missing update
then brought them all in at once. The room now counts them towards `COLLAB_MAX_DOCUMENT_BYTES`, drops them when
they outgrow `COLLAB_MAX_UPDATE_BYTES` and refuses their sender (a client on one socket never produces them). An
attachment's upload form stays valid for ten minutes after the file was checked, so the checked file is now a
server-side copy the form cannot overwrite ([Storage](storage.md)). And collab served `/metrics` on its public port without any check (its connection and
room counts, close codes and rejected-update counts were readable by anybody). It now needs `METRICS_TOKEN`, on the
api as well.

## Known limits

- The mock payment provider (`BILLING_PROVIDER=mock`) is public by design: it stands in for an external service, and
  anyone who knows a checkout session id can complete it (rate limited per address). A real provider replaces the module; the webhook behind it
  authenticates by signature either way.
- `script-src` keeps `'unsafe-inline'` on static and published pages (see above); `style-src` keeps it everywhere (the
  editor and the toasts set inline styles).
