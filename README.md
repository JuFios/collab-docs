# Collab Docs

Collaborative workspace with real-time document editing: workspaces, nested documents, CRDT-based
co-editing, sharing and publishing, search, comments and billing.

> Work in progress. Sections below are filled in as the project grows.

## Architecture

pnpm monorepo:

| Path              | Purpose                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `apps/web`        | Next.js 15 (App Router, Tailwind). Route groups `(public)` and `(app)`. |
| `apps/api`        | NestJS REST API (`GET /health`).                                        |
| `apps/collab`     | NestJS WebSocket server for document co-editing (Yjs), `GET /health`.   |
| `packages/shared` | Framework-free shared code with entry points `.` and `./content`.       |
| `packages/nest`   | Server-only NestJS building blocks shared by `api` and `collab`.        |
| `packages/db`     | Prisma schema, migrations, seed and integration-test harness.           |

`@collab-docs/nest` is server-only; ESLint forbids importing it (and `@collab-docs/db`) in
`apps/web`.

## Run

### With Docker (no setup)

Requires Docker with Compose v2. From a clean clone, without any `.env` file:

```bash
docker compose up --build --wait
```

Compose carries development-only defaults for every variable, so nothing else is needed. Copy
`.env.example` to `.env` to override values.

| Service    | URL / port                                  | Notes                                                                                    |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `proxy`    | http://localhost:3000                       | nginx, the only public HTTP entry point; sets `X-Forwarded-For` for `web`                |
| `web`      | - (behind `proxy`)                          | Next.js                                                                                  |
| `api`      | http://localhost:4000 (`/health`, `/ready`) | NestJS REST API                                                                          |
| `worker`   | -                                           | Background jobs (same image as `api`)                                                    |
| `collab`   | `localhost:4001` (`/health`)                | Public WebSocket port. Internal port `4002` is only reachable inside the compose network |
| `postgres` | `localhost:5432`                            | Database `collab`                                                                        |
| `redis`    | `localhost:6379`                            |                                                                                          |
| `minio`    | http://localhost:9000, console `:9001`      | S3 storage; bucket created by `minio-init`                                               |
| `mailpit`  | http://localhost:8025, SMTP `:1025`         | Catches outgoing email                                                                   |
| `migrate`  | -                                           | One-shot job that runs before the apps                                                   |

Host ports can be changed with `WEB_PORT`, `API_PORT`, `POSTGRES_PORT`, etc. (see `.env.example`).

MinIO's official images are no longer published, so `docker/minio/Dockerfile` builds the server and
the `mc` client from the last tagged source releases.

Only infrastructure for local development: `docker compose up -d postgres redis minio minio-init mailpit`.

### Staging profile

```bash
cp .env.staging.example .env.staging   # fill in every value
docker compose --env-file .env.staging -f docker-compose.yml -f docker-compose.staging.yml up -d
```

The override sets `APP_ENV=staging` and `NODE_ENV=production`, hides database, cache and console
ports, restarts services automatically, and requires every secret. On startup `api` and `collab`
validate their environment and refuse to run with missing values or `dev-only` placeholders.

### Without Docker

Requires Node.js >= 22.12 (see `.nvmrc`) and pnpm 10, plus the infrastructure services above.

```bash
pnpm install
pnpm dev
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: lint and typecheck,
unit and integration tests (Postgres and Redis service containers plus the compose `minio` image, which is built
from source and reuses the layer cache of the image build job), Docker image builds for `web`, `api`,
`collab` and `minio`, and the Playwright `e2e` job against the compose stack (see [Running e2e](#running-e2e)).

## Development

| Command                   | What it does                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`               | ESLint (flat config) for the whole repo                                                                                                       |
| `pnpm typecheck`          | `tsc --noEmit` in every package                                                                                                               |
| `pnpm test`               | Jest (api, collab) and Vitest (web, shared, nest)                                                                                             |
| `pnpm test:integration`   | Integration tests (needs Postgres and Redis; set `MAILPIT_URL=http://localhost:8025` with Mailpit running to include the email delivery test) |
| `pnpm build`              | Builds shared libraries, then every app                                                                                                       |
| `pnpm format`             | Prettier                                                                                                                                      |
| `pnpm --filter api start` | Runs the built API                                                                                                                            |

Libraries in `packages/*` are built before type checking and testing (`pnpm build:libs`, run
automatically by `typecheck` and `test`).

### Module system

`jose` is ESM-only, so the choice below was verified with smoke tests in every runtime:

- `packages/shared` is a dual package (`"type": "module"`, built with tsup to ESM `.js` and CJS
  `.cjs`, with matching type declarations) exposed through conditional `exports`. It has no NestJS code.
- `packages/nest` is CommonJS and built with `tsc`, because decorator metadata is only emitted by `tsc`
  (and by swc), not by esbuild; it requires ESM-only `jose` the same way the apps do.
- `apps/api` and `apps/collab` stay CommonJS (NestJS). At runtime Node loads ESM-only `jose`
  through `require(esm)`, which is why Node >= 22.12 is required.
- Dependency injection is type-based: constructors name the class and Nest reads it from the decorator
  metadata emitted by `tsc` (build) and `@swc/jest` (tests, `apps/api/.swcrc`). `@Inject()` stays only for
  `Symbol` tokens (`REDIS_CLIENT`, `DOCUMENT_STORE`) and for the one property injection in the throttler guard. A class used in a constructor must be a value
  import, never `import type`; the `consistent-type-imports` rule is configured to respect that. Vitest
  (esbuild) emits no metadata, so tests of injectable classes belong in the Jest suites.
- Jest runs through `@swc/jest`; `transformIgnorePatterns` lets `jose` be transformed to CommonJS.
- Vitest (web, shared) and `next build` import the package natively as ESM.

## Data model

Postgres, managed with Prisma 7 in `packages/db` (`prisma/schema.prisma`, migrations in
`prisma/migrations`). Tables and columns are snake_case, ids are UUID v7.

```mermaid
erDiagram
  users ||--o{ refresh_tokens : has
  users ||--o{ workspaces : owns
  users ||--o{ workspace_members : "member of"
  workspaces ||--o{ workspace_members : has
  workspaces ||--o{ workspace_invites : has
  workspaces ||--|| subscriptions : has
  workspaces ||--o{ documents : contains
  documents ||--o{ documents : "parent of"
  documents ||--o{ document_shares : "shared via"
  users ||--o{ document_shares : "granted"
  documents ||--o{ public_links : "published via"
  workspaces ||--o{ attachments : "stores"
  documents ||--o{ attachments : "embeds"
```

Notes:

- **Documents form a tree** (`parent_id`) ordered by `position`, a fractional-indexing key. The column
  is created `COLLATE "C"` so keys compare bytewise; the database default collation would sort mixed
  case differently and break the ordering.
- **Soft delete**: `deleted_at` marks a document, `deleted_root_id` the document where the deletion
  started, so a restore brings back only that deletion's subtree.
- **`revision`** is incremented atomically on every change that derived data (search index, public
  pages) must follow.
- **Indexes**: the tree listing uses a partial index `documents_tree_idx (workspace_id, parent_id,
position) WHERE deleted_at IS NULL`; the rest are plain b-tree indexes on foreign keys and unique
  lookups (emails, slugs, token hashes, one share per user and document, one public link per document
  and mode). Partial indexes, `COLLATE "C"` and the `pg_trgm`/`unaccent` extensions are written by hand
  in the first migration; the partial index keeps the name declared in the schema, so
  `pnpm --filter @collab-docs/db db:drift` still reports no drift.
- **Foreign keys**: rows that make no sense without their parent (memberships, refresh tokens, shares,
  public links, the subscription) cascade; workspace owners, document authors and workspaces that
  still hold documents are `RESTRICT`, so content is never deleted implicitly.
- Emails are stored lower-case (normalised by the application) and are unique.

### Database commands

| Command                                    | What it does                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @collab-docs/db db:migrate` | Create/apply migrations in development                                                                             |
| `pnpm --filter @collab-docs/db db:deploy`  | Apply existing migrations (what the `migrate` job runs)                                                            |
| `pnpm --filter @collab-docs/db db:seed`    | Idempotent demo data (dev only): `alice`, `bob`, `carol` `@example.test`, password `password123`, workspace `acme` |
| `pnpm --filter @collab-docs/db db:reset`   | Drop, re-migrate and re-seed                                                                                       |
| `pnpm --filter @collab-docs/db db:drift`   | Fails if migrations and `schema.prisma` diverge                                                                    |
| `pnpm test:integration`                    | Integration tests against a real Postgres                                                                          |

All of them read `DATABASE_URL`. Integration tests use `createTestDb()` from
`@collab-docs/db/testing`: each Jest worker creates its own throwaway database on that server,
applies the migrations and truncates tables between tests.

## API platform

Shared by `api`, its queue worker and (later) `collab`: it lives in `@collab-docs/nest`, and each
app only plugs the modules in (`PlatformModule` for HTTP services, `WorkerPlatformModule` for the worker).

- **Configuration**: `@nestjs/config` (`ConfigModule`, global) validates the process environment with the zod
  schema in `@collab-docs/nest` before anything starts, so a missing or malformed variable stops the process
  with the full list of problems (`APP_ENV=staging` additionally rejects development placeholders). Services
  inject `ConfigService<AppConfig, true>` and read `config.get('NAME', { infer: true })`. Env files are loaded by
  the runtime (`node --env-file`, Docker Compose), never by the app.
- **Prefix**: routes live under `/api`; `/health`, `/ready`, `/metrics` and `/docs` are served without it.
- **Validation**: a global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`; registered as an `APP_PIPE` provider), `ParseUuidPipe`
  for ids, and base DTOs for pagination and id params. Request/response contracts are zod schemas in
  `@collab-docs/shared`; response DTO classes `implements` the inferred types, and integration tests parse
  real responses with the same schemas, so backend and frontend cannot drift apart silently.
- **HTTP hardening**: `helmet`, a CORS allowlist (`WEB_ORIGIN` plus `CORS_ALLOWED_ORIGINS`), `cookie-parser`,
  a JSON/urlencoded body limit (`HTTP_BODY_LIMIT`, default `1mb`) and `trust proxy` restricted to
  `TRUSTED_PROXY_CIDRS` (empty means `x-forwarded-for` is never trusted).
- **Rate limiting**: `@nestjs/throttler` with a Redis store, keyed by the real client IP. A generous global
  limit (`RATE_GLOBAL_PER_MIN_IP`) applies everywhere; `RateLimit.login()`, `.register()`, `.publicLink()` and
  `.ticket()` are per-route presets whose limits come from the `RATE_*` variables. If Redis is unavailable
  the limiter fails open and logs the error.
- **OpenAPI**: Swagger UI at `/docs`, JSON at `/docs/json`. `pnpm --filter @collab-docs/api openapi:export`
  writes the committed `docs/openapi.json` (the app is built without connecting to anything).

### Error model

Every error response has the same shape, produced by one global `AllExceptionsFilter` (an `APP_FILTER` provider):

```json
{
  "statusCode": 400,
  "code": "VALIDATION_FAILED",
  "message": "Request validation failed",
  "details": [
    { "field": "name", "messages": ["name must be longer than or equal to 1 characters"] }
  ],
  "correlationId": "6f1c3f0e-…"
}
```

`code` comes from the catalog in `@collab-docs/shared` (`VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`,
`NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PLAN_LIMIT_EXCEEDED`, `PAYLOAD_TOO_LARGE`, …) and clients branch on
it, never on `message`. Application code throws `AppException(code, message, { details })`. Framework and
library errors are mapped: validation errors become 400, Prisma `P2002` 409, `P2025` 404, throttling 429,
oversized or malformed bodies 413/400. Anything unrecognised is a 500 with a generic message — the real
error is logged with the correlation id but never returned.

### Logging & correlation

Logs are JSON (`nestjs-pino`). Each request gets a correlation id: the incoming `x-correlation-id` if it is a
short, log-safe token, otherwise a new UUID. It is stored in `AsyncLocalStorage`, added to every log line,
returned in the `x-correlation-id` response header and in every error body. When code enqueues a job the id
is written into the job data, and the worker restores it before running the processor, so one id follows a
change from the browser through the API into background work (and later the collab server). Secrets are
redacted from logs (`authorization`, `cookie`, `set-cookie`, passwords, tokens). Classes get their logger by
injection (`@InjectPinoLogger(MyService.name)`), which adds a `context` field; business events are logged with
`logEvent(this.logger, 'document.published', { … })` (an `event` field plus the same name as the message).

### Observability

- `GET /health` — liveness (checks nothing, so a database outage never restarts the container; the Docker
  healthchecks use it). `GET /ready` — readiness: pings Postgres and Redis (2 s each) and answers `503` when one is
  down. Both use the standard `@nestjs/terminus` body, `{ status, info, error, details }`; a failing dependency
  shows up as `{ status: 'down' }` under `error` and `details`, without the underlying error message.
- `GET /metrics` — Prometheus: default process metrics, `http_request_duration_seconds{route,method,status}`
  (labelled by route pattern, not raw URL) and queue metrics (`queue_jobs{queue,state}`,
  `queue_jobs_processed_total{queue,result}`). The endpoint is unauthenticated, so keep it off public ingress.

### Queues

BullMQ queues (`search-sync`, `public-revalidate`, `mail`, `billing-webhook`, `link-expiry`, `version-prune`, `attachment-cleanup`)
are registered once with `@nestjs/bullmq` (`BullModule.registerQueue`), with default retries (5 attempts,
exponential backoff) and bounded history. Producers inject a queue (`@InjectQueue(name)`) or use `QueueService`;
either way `addJob` stamps the ambient correlation id into the job. Consumers are `@Processor(name)` classes that
extend `QueueProcessor`: it restores the correlation context, counts results and logs failed jobs, and the class
only implements `handle(job)`. The worker runs from the same image as the API (`node dist/main.worker.js`) and
shuts down gracefully, finishing active jobs. `enqueueDebounced(queue, documentId, delayMs)` coalesces bursts of
changes into one delayed job using BullMQ deduplication; the job reads the latest state when it runs, and a
change made while it is processing schedules a new job. A fixed `jobId` per document is deliberately not
used, because BullMQ remembers finished ids and would drop later changes.

## Authentication

Own JWT auth in the API (`apps/api/src/auth`), no external identity provider.

| Endpoint                  | Purpose                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /api/auth/register` | Create an account and sign in (409 if the email exists)                                       |
| `POST /api/auth/login`    | Sign in                                                                                       |
| `POST /api/auth/refresh`  | Rotate the refresh token, issue a new access token                                            |
| `GET /api/auth/refresh`   | Same rotation for browser navigations; `302` to `?next=` (relative paths only) or to `/login` |
| `POST /api/auth/logout`   | Revoke the refresh-token family, clear the cookies                                            |
| `GET /api/auth/me`        | The signed-in user (read from the database)                                                   |

Register, login and refresh answer `{ user, accessToken, expiresIn }` and set two cookies. The access token
is also accepted as `Authorization: Bearer` (Swagger, tests, non-browser clients).

| Cookie  | Content                       | Attributes                               |
| ------- | ----------------------------- | ---------------------------------------- |
| `cd_at` | access JWT, 15 min            | `HttpOnly; SameSite=Lax; Path=/`         |
| `cd_rt` | opaque refresh token, 30 days | `HttpOnly; SameSite=Lax; Path=/api/auth` |

Both are `Secure` when `APP_ENV=staging`. The browser reaches the API same-origin through the web app's
`/api/*` rewrite, so the cookie paths match.

For other modules: every route requires a valid access token unless it is marked `@Public()`; the user is
available through `@CurrentUser()` (`{ id, jti }`). The guard verifies the JWT locally and never touches the
database. The API issues and verifies the token with `@nestjs/jwt` (`AccessTokenService`, `JwtModule` configured
from `JWT_ACCESS_SECRET`). Next's Edge middleware cannot use it, so `verifyAccessToken()` in `@collab-docs/shared`
verifies the same token with `jose` (Web APIs only). The two implementations are tied together by a contract test
(`access-token.service.spec.ts`): a token from either side must verify on the other with the same claims, and
expired, tampered, wrong-audience, wrong-algorithm and incomplete tokens must be rejected by both. The collab
ticket stays on `jose` (`signCollabTicket`/`verifyCollabTicket`), because the API signs it and collab verifies
it with the same code, so there is no second implementation to keep in step.

### Auth design & rationale

**Why our own JWT instead of Auth.js.** The API is a separate NestJS service that also guards a WebSocket
gateway and server-to-server calls, so identity has to be verifiable outside Next. A signed access token that
any service can check with one shared secret does that; Auth.js sessions live inside the Next runtime. Owning
the flow also keeps rotation, reuse detection and rate limits in one place and testable at the HTTP level.

**Access + refresh.** The access JWT is short-lived (15 min; `sub`, `jti`, `aud=api`) and checked without a
database read. The refresh token is 256 random bits; only its SHA-256 is stored (`refresh_tokens.token_hash`),
so a database leak does not yield usable tokens. Passwords use argon2id (`@node-rs/argon2`; memory, time and
parallelism come from `ARGON2_*`, defaults follow the OWASP minimum). A wrong password and an unknown email
produce the same response and cost the same time.

**Rotation and the 30 s grace.** Each refresh replaces the token (`rotated_at`, `replaced_by`) inside one
family (`family_id`). The rotation claim is a single conditional `UPDATE ... WHERE rotated_at IS NULL`, so of
two parallel refreshes with the same token exactly one rotates. A rotated token that is presented again within
30 s (parallel requests, several tabs, a response lost on the wire) only yields a new access token and no
second rotation, so the user is not logged out by a race. Presented later, a rotated token means it was
copied: the whole family is revoked, the request gets `401`, and `auth.refresh_reuse_detected` is logged.
Logout revokes the family too.

**CSRF.** `SameSite=Lax` plus a global guard: a state-changing request authenticated by cookies (`cd_at` or
`cd_rt`, so refresh and logout included) must carry `Origin` equal to `WEB_ORIGIN`, otherwise `403
CSRF_REJECTED`. Bearer requests are exempt (browsers do not attach that header on their own), as are
requests without auth cookies such as login and webhooks.

**Rate limits.** Login: 5/min per (client IP, email) and 20/min per IP; register: 10/h per IP (`RATE_*` in
`.env.example`). Exceeding them returns `429 RATE_LIMITED` with `Retry-After`. The client IP is `req.ip`,
which honours `x-forwarded-for` only from `TRUSTED_PROXY_CIDRS`.

**HS256 vs ES256/JWKS.** HS256 with a dedicated secret (`JWT_ACCESS_SECRET`) is the simplest thing that works
for services we deploy together; every verifier holds the secret. The cost is that every verifier could also
mint tokens. To move to ES256 with a JWKS endpoint, the API would sign with a private key and publish the
public key; `AccessTokenService` and `verifyAccessToken` are the only places that change, and `jose` already supports
`createRemoteJWKSet`. Rotating keys then needs only a `kid`, with no secret redistribution.

## Workspaces, members and invites

`apps/api/src/workspaces`. A user creates a workspace and becomes its `OWNER`; the workspace starts on the
`FREE` plan. Roles: `OWNER`, `ADMIN`, `EDITOR`, `VIEWER`.

| Endpoint                                       | Minimum role | Purpose                                              |
| ---------------------------------------------- | ------------ | ---------------------------------------------------- |
| `POST /api/workspaces`                         | any user     | Create a workspace (slug is generated from the name) |
| `GET /api/workspaces`                          | any user     | Workspaces the caller belongs to                     |
| `GET /api/workspaces/:id`                      | `VIEWER`     | One workspace                                        |
| `PATCH /api/workspaces/:id`                    | `ADMIN`      | Rename                                               |
| `GET /api/workspaces/:id/usage`                | `VIEWER`     | Members, documents, storage against the plan limits  |
| `GET /api/workspaces/:id/members`              | `VIEWER`     | Members                                              |
| `PATCH /api/workspaces/:id/members/:userId`    | `ADMIN`      | Change a role                                        |
| `DELETE /api/workspaces/:id/members/:userId`   | `VIEWER`     | Leave (own id) or remove a member (`ADMIN`)          |
| `POST /api/workspaces/:id/invites`             | `ADMIN`      | Invite an email (never as `OWNER`), emailed          |
| `GET /api/workspaces/:id/invites`              | `ADMIN`      | Pending invites                                      |
| `DELETE /api/workspaces/:id/invites/:inviteId` | `ADMIN`      | Revoke                                               |
| `GET /api/invites/:token`                      | public       | Preview (workspace, email, role) for the accept page |
| `POST /api/invites/:token/accept`              | signed in    | Join; the account email must equal the invited email |

Rules enforced on the server: an admin can neither change or remove an owner nor grant `OWNER`; the last
owner can be neither demoted nor leave (`409`); a role change or removal publishes `perm.changed` on Redis
once the transaction has committed (the real-time server listens to it). Both rules run under the workspace
row lock, so two concurrent demotions cannot leave a workspace without an owner.

**Invites.** The token is 256 random bits, valid for 7 days, and only its SHA-256 is stored. Inviting an
address that already has a pending invite re-issues it (new token, new expiry, the old link stops working);
inviting an existing member is `409`. The email is sent by the `mail` queue (nodemailer to SMTP, Mailpit in
development at <http://localhost:8025>); the worker retries with exponential backoff and the HTML template
escapes every user-supplied value. The queue payload carries the accept link, so Redis holds a valid token
until the job is removed (one hour after success).

**Plan limits.** `PLAN_CATALOG` in `@collab-docs/shared` (Free 3 members / 20 documents / 100 MB, Pro
10 / 500 / 5 GB, Team 50 / unlimited / 50 GB). Members are accepted members plus pending invites; people who
only have a document shared with them (guests) do not count. Every check runs in a transaction that first
takes `SELECT ... FOR UPDATE` on the workspace row, so N parallel invites at the limit produce exactly the
allowed number of successes. Exceeding a limit returns `403` with
`{ code: 'PLAN_LIMIT_EXCEEDED', details: { kind, limit, current, plan } }`. After a downgrade, existing
members stay and new ones are blocked, including accepting an invite that was issued earlier.

## Permission model

Access is decided by pure functions in `packages/shared/src/permissions.ts`, so the API, the collab server
and the tests share one definition. `PermissionsService` (`apps/api/src/permissions`) loads the minimal
context (membership, share, visibility) and calls them. **Nothing is cached**: a revoked permission applies
to the next request. Routes declare their requirement with `@WorkspaceRole('ADMIN')` or
`@DocumentAccess('EDIT')`.

Document access, evaluated top to bottom:

| #   | Condition                                | Access                                       |
| --- | ---------------------------------------- | -------------------------------------------- |
| 1   | Document is deleted                      | `NONE` (restore: Owner/Admin, Editor-author) |
| 2   | Role is `OWNER` or `ADMIN`               | `MANAGE`                                     |
| 3   | The user has a `document_share`          | share `EDITOR` -> `EDIT`, `VIEWER` -> `VIEW` |
| 4   | Member and visibility is `WORKSPACE`     | `EDITOR` -> `EDIT`, `VIEWER` -> `VIEW`       |
| 5   | Anything else (non-member, `RESTRICTED`) | `NONE`                                       |

An explicit share overrides the workspace role in both directions. Public links are a separate path: a
`VIEW` link allows anonymous reading of the published page, a live `EDIT` link grants `EDIT` on that one
document to a guest who cannot comment.

```mermaid
flowchart TD
  A[Request with document id] --> B{Document exists and not deleted?}
  B -- no --> N[404]
  B -- yes --> C{Owner or Admin?}
  C -- yes --> M[MANAGE]
  C -- no --> D{Has a share?}
  D -- yes --> S[VIEW or EDIT from the share]
  D -- no --> E{Member and visibility WORKSPACE?}
  E -- yes --> R[VIEW or EDIT from the role]
  E -- no --> N
  M --> G{Enough for the action?}
  S --> G
  R --> G
  G -- yes --> OK[200]
  G -- no --> F[403]
```

**404 vs 403.** No access at all (not a member, `RESTRICTED` without a share, deleted, unknown id, malformed
id) gives `404`, so the response never confirms that a resource exists; access that is too low for the action
gives `403`. A member of a workspace also gets `403` where a non-member gets `404`.

Creating a document needs `EDITOR` and `EDIT` on the parent; the child copies the parent's visibility and
shares at that moment (a snapshot, not live inheritance). Moving needs `EDIT` on the document and on the new
parent, the same workspace and no cycle. Only `EDITOR` and above can comment.

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

| Channel / queue                                 | When                                     | Consumers                                 |
| ----------------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| `realtime.events` -> `GET /events/stream` (SSE) | tree changed                             | browsers of that workspace                |
| `perm.changed`, `doc.deleted`, `doc.restored`   | visibility/share change, delete, restore | collab re-evaluates open sockets          |
| `public-revalidate` (3 s), `search-sync` (5 s)  | title, icon, delete, restore             | page revalidation and search (later work) |

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
  as `collab.update_rejected` without disturbing the other clients.
- **Metrics** (`/metrics`): `collab_connections`, `collab_rooms`, `collab_updates_applied_total`,
  `collab_updates_duplicate_total`, `collab_updates_rejected_total{reason}`, `collab_rate_limited_total`,
  `collab_ws_close_total{code}`, `collab_access_changes_total{outcome}`, plus the platform metrics.
- **Internal port 4002** is a second application inside the same process (sharing the rooms), never published
  by compose; every route needs `Authorization: Bearer <INTERNAL_API_TOKEN>`.
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
4. After the commit the store tells the room, which sends `persisted {sv}` to its clients, and (fire-and-forget)
   queues `document.changed` for search (5 s debounce) and page revalidation (3 s). A Redis outage is logged and
   counted, and editing continues.

**Failures.** If the write fails, the buffer is kept in order and retried with backoff (1, 2, 5, 10, then every
30 s); a room whose updates are not written is not unloaded, and loading a document first writes whatever the store
still holds for it. Shutdown (`SIGTERM`) flushes every buffer before the database connection is closed.

**Saved means durable.** `y-websocket` does not acknowledge updates, so the server reports what is in the database
as a state vector (`persisted`, also once on connect) and the client computes `hasUnsyncedChanges =
!covers(persistedSV, localSV)` (`stateVectorCovers` in `@collab-docs/shared`). The same check gates publishing:
"publish only saved changes".

**The loss window.** If the process is killed (`kill -9`, power) the server loses at most the updates buffered since
its last flush, up to 5 s. They are not lost for good while the author's tab is open: the browser keeps its `Y.Doc`
and, on reconnect, answers the server's sync step 1 with everything the server lacks. What cannot be recovered is
a tab closed inside that window, which is why the editor is designed to show "Saving…" until `persisted` covers the
local state and to warn before the page is left with unsaved changes.

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
collab (`POST :4002/internal/documents/:id/restore`), because only the service that owns the live document can
change it safely. Collab loads the room if nobody has it open, writes its buffer, saves the `PRE_RESTORE` snapshot,
then replaces the children of the content fragment with clones of the version's in **one Yjs transaction** made by
the server and flushes. Connected clients receive it like any other update and converge; the edit history is not
rewritten, so a restore can itself be undone from the pre-restore snapshot. If collab is unavailable the api answers
`503` rather than pretend.

**Deleting a document while it is edited.** The api's `doc.deleted` event (or `POST :4002/internal/documents/:id/close`)
makes collab write the buffer first, since restore needs the content, then send `deleted` and close the sockets with 4410.

Internal endpoints on port 4002 (`Authorization: Bearer <INTERNAL_API_TOKEN>`): `POST /internal/documents/:id/flush`
(returns `{ revision }`), `.../restore { versionId, userId }`, `.../close`.

## Storage and attachments

Images live in an S3-compatible bucket (MinIO in development) and never pass through the api: the browser
uploads them with a presigned POST. A document refers to an image by `attachmentId` only (see
[Content model](#content-model)); external URLs and SVG are not part of the model.

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as api
  participant S as bucket
  B->>A: POST /documents/:id/attachments/presign {filename, mime, size}
  A->>A: EDIT check, type/size checks, quota (workspace row locked), row PENDING
  A-->>B: {attachmentId, url, fields}
  B->>S: POST url (fields first, file last)
  S-->>B: 204 (the policy pins key, type and exact length)
  B->>A: POST /attachments/:id/complete
  A->>S: HEAD, then the first bytes
  A-->>B: READY, or 422 and the object is deleted
  B->>A: GET /attachments/:id/url
  A-->>B: presigned GET, valid for 5 minutes
```

| Endpoint                                  | Needs | Notes                                                                                                                                                               |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /documents/:id/attachments/presign` | EDIT  | `{filename, mime, size}` → `{attachmentId, url, fields, expiresAt}`; `413` over the per-file limit, `403 PLAN_LIMIT_EXCEEDED` with `kind: 'storage'` over the quota |
| `POST /attachments/:id/complete`          | EDIT  | idempotent; `422` with `details.reason` (`not_uploaded`, `size_mismatch`, `type_mismatch`, `content_mismatch`)                                                      |
| `GET /attachments/:id/url`                | VIEW  | only completed uploads; the access check runs on every call, so a revoked role or a deleted document stops it at once                                               |

**Three layers refuse anything that is not png, jpeg, webp or gif.**

1. _Presign_: the type is an allowlist, the file name's extension has to belong to it, the size is capped
   (`ATTACHMENT_MAX_BYTES`, 10 MB by default). `image/svg+xml`, `text/*` and the rest are `400`.
2. _Bucket policy_: the form is signed with conditions on the key, the `Content-Type` and
   `content-length-range` set to the declared size, so the bucket itself answers `EntityTooLarge`,
   `EntityTooSmall` or `403` for anything else, however the client was modified.
3. _Sniffing on completion_: the stored size and content type are compared with what was declared and the
   first bytes are checked against the magic numbers of the four formats. A text file called `fake.png`
   passes layers 1 and 2 and stops here; the object and its row are deleted.

**Quota.** `SUM(size)` over the workspace's attachments (completed and pending) has to stay within the plan
(100 MB / 5 GB / 50 GB). The check and the insert run in one transaction under `SELECT ... FOR UPDATE` on the
workspace row, the same lock the member and document limits use, so two parallel presigns cannot both take
the last bytes. `GET /workspaces/:id/usage` reports the same figure.

**Two S3 clients.** The server talks to `S3_ENDPOINT` (the compose network name, `minio:9000`); URLs given to
browsers are signed for `S3_PUBLIC_ENDPOINT` (`localhost:9000`), because a signature covers the host. The
bucket's CORS origin is `WEB_ORIGIN` (`MINIO_API_CORS_ALLOW_ORIGIN` in `docker-compose.yml`).

**Lifecycle.** Objects are stored as `ws/{workspaceId}/doc/{documentId}/{uuid}`. A `PENDING` row older than
`ATTACHMENT_PENDING_TTL_HOURS` (24) is removed by an hourly worker job together with its object. The job
claims rows with `DELETE ... RETURNING` before touching the bucket, so a completion racing the sweep fails
with `404` and never leaves a `READY` row without a file. Deleting a document is a soft delete and keeps its
attachments; purging them is not done (see [Not done](#not-done)).

## Frontend

`apps/web` is a Next.js 15 App Router application (Tailwind, shadcn/ui primitives on Radix, Geist fonts
bundled through npm so builds need no network).

### Frontend: Server vs Client boundary

Server Component is the default: anything that reads data and needs no browser state. A Client Component
(`"use client"`) exists only where the browser is required, and each one is listed here with the reason:

| Client component                                                                                            | Why                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `components/providers.tsx`                                                                                  | TanStack Query provider and the toast outlet                                                                                  |
| `components/auth/login-form.tsx`, `register-form.tsx`                                                       | `useActionState` (pending state, field errors) and a zod pass before the round trip                                           |
| `components/user-menu.tsx`                                                                                  | Radix menu; the logout Server Action runs from its event handler                                                              |
| `components/workspaces/create-workspace-form`, `rename-workspace-form`, `invite-form`, `accept-invite-form` | `useActionState` (pending state, field errors, plan-limit explanation) and a zod pass before the round trip                   |
| `components/workspaces/members-table.tsx`, `pending-invites.tsx`                                            | Role selects, the remove confirmation and revoke call Server Actions from event handlers                                      |
| `components/workspaces/leave-workspace-button.tsx`                                                          | Confirmation dialog; the action runs from an event handler, then navigation and refresh                                       |
| `components/workspaces/workspace-switcher.tsx`                                                              | Radix menu; the current workspace comes from the pathname, the list arrives as typed props                                    |
| `components/workspaces/workspace-nav.tsx`                                                                   | `usePathname` marks the active section                                                                                        |
| `components/workspaces/use-action-feedback.ts`, `use-validated-action.ts`                                   | Hooks: success toast and plan-limit event; `useActionState` that runs the zod schema in the browser before calling the action |
| `components/workspaces/workspace-provider.tsx`                                                              | Owns the tab's single SSE connection and hands the workspace role, the initial tree and the connection state to the sidebar   |
| `components/documents/document-tree.tsx`, `tree-row.tsx`, `workspace-sidebar.tsx`                           | TanStack Query, drag and drop (pointer events), roving focus and keyboard handling; none of it exists on the server           |
| `components/documents/document-shell.tsx`, `document-title.tsx`, `document-gone.tsx`                        | Debounced inline title, live refetch when the document is renamed or deleted elsewhere, restore button                        |
| `components/documents/trash-list.tsx`                                                                       | Restore runs from an event handler, then the server-rendered list is refreshed                                                |
| `components/dashboard/block-boundary.tsx`                                                                   | Error boundaries must be class components; one per dashboard block                                                            |
| `app/(app)/w/[id]/error.tsx`                                                                                | Error boundary of the workspace segment (keeps the navbar and workspace header)                                               |
| `components/ui/dialog`, `dropdown-menu`, `label`, `sonner`                                                  | Radix/Sonner primitives that need effects and event handlers                                                                  |
| `app/error.tsx`                                                                                             | Error boundaries must be Client Components                                                                                    |

Screens and where they render (everything not listed as a client island is a Server Component):

| Screen                | Renders in                             | Why                                                                                                                                                                                                             |
| --------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/w`                  | RSC page + client create form          | The list is a plain read; the form needs pending state and field errors. Redirects to the last opened workspace (`cd_ws` cookie, set by the middleware) unless `?all` is present                                |
| `/w/[id]` (dashboard) | RSC, four async RSC blocks             | Each block has its own `Suspense` + error boundary, so the shell and skeletons flush first and the blocks stream in independently                                                                               |
| `/w/[id]/settings`    | RSC page + client forms/tables         | Data is read on the server (admin-only, `ForbiddenState` otherwise); every mutation is a Server Action                                                                                                          |
| `/invite/[token]`     | RSC                                    | Previews the invite on the server and branches on the session: sign in / register links, a mismatch warning, or the accept form                                                                                 |
| `/w/[id]/d/[docId]`   | RSC page + client shell                | The page reads the document and its `myAccess` on the server (404 / `ForbiddenState`, and a "deleted" state that is looked up in the trash); the shell is a client island for the inline title and live refresh |
| `/w/[id]/trash`       | RSC page + client list                 | Plain read of what the caller may restore; Restore is a REST call followed by `router.refresh()`                                                                                                                |
| `/shared`             | RSC                                    | Documents shared with the caller in any workspace; a guest opens one without the workspace frame                                                                                                                |
| Navbar                | RSC shell + switcher/user-menu islands | The workspace list is fetched in the layout and passed down as typed props                                                                                                                                      |

**Dashboard streaming.** `app/(app)/w/[id]/page.tsx` awaits nothing but the workspace the layout already loaded
(deduplicated by `React.cache`). The blocks (`components/dashboard/blocks.tsx`: recent documents, members,
plan and usage, shared with me) are async Server Components under their own `<Suspense>`, so a slow or failing
block never holds back the others. The e2e suite asserts this on the raw response: with
`DASHBOARD_BLOCK_DELAY_MS` set (ignored when `APP_ENV=staging`) the first flush contains the skeletons and not
the data, and the data arrives later in the same response.

### Document tree and live updates

The sidebar of every `/w/[id]/…` page is a Client Component fed by a Server Component: the layout fetches the flat
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
  opens `/w/[id]/d/[docId]` without the workspace frame: the layout renders its children bare when the user is
  not a member, and every other page of the segment answers 404 through `requireWorkspace`.

### Server Actions vs REST vs WebSocket

| Operation                                                                                       | Channel               | Why                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Create/rename workspace, invite, change role, remove member, revoke/accept invite, login/logout | **Server Actions**    | Forms that work as plain `<form action>`, cookies handled on the server, `revalidatePath` refreshes the Server Components that show the data |
| Document tree (move/create/rename/delete), comments, sharing, publishing                        | REST + TanStack Query | Interactive, optimistic UI and cache invalidation in the browser                                                                             |
| Notifications, tree changes                                                                     | SSE                   | One-way push                                                                                                                                 |
| Document content, presence                                                                      | WebSocket (Yjs)       | Conflict-free merging and awareness                                                                                                          |

Server Actions call the api through `lib/api/server.ts` (cookies, `x-forwarded-for`, correlation id), validate
their input with the zod schemas of `@collab-docs/shared` (arguments of actions that are not form posts are
validated too, since they are public endpoints), and report failures as data (`ActionState`): field errors,
a plain-language plan-limit explanation (`PLAN_LIMIT_EXCEEDED` also fires the window event the upgrade dialog
will subscribe to), or a generic message. Forms run the same schema in the browser first, inside the action
function (`use-validated-action.ts`), so field errors appear without a round trip. Authorization is always the
api's; hiding admin controls in the UI is convenience only.

**Why actions do not call `revalidatePath` or `redirect`.** The api client is never cached, so there is no server
data cache to purge; what a mutation needs is a fresh render of the current page. Calling `revalidatePath` or
`redirect` inside the action makes the action response carry that render, and on the production build (Next 15.5,
React 19.2) forms that did so intermittently stayed pending or never showed the result, with or without the nginx
proxy in front. Two things were measured: a `loading.tsx` above the workspace layouts made it much worse (6 of 16
submits of the invite form stalled, against 0 of 78 once the skeletons were scoped to their own segments, which
is why the list skeleton lives in the `app/(app)/w/(list)` route group), but revalidating actions still flaked
in the parallel e2e run (create and rename, 2 of 4 runs). So an action only returns data (`ActionState`, including
`redirectTo` after creating a workspace or accepting an invite) and the component finishes the job in
`useActionFeedback`: toast, `router.push` when asked, and `router.refresh()`, a separate GET that also re-renders the
layouts (the navbar switcher picks up a new workspace). Components that call actions from event handlers (role
select, remove, revoke) refresh the same way. The root cause inside Next/React is not identified.

Route groups keep the rendering mode of each area separate:

- `app/(public)` — landing, `/login`, `/register`, `/invite/[token]` (later `/p/[slug]`, `/e/[token]`).
- `app/(app)` — everything behind a session (`/w`, `/w/[id]`, `/w/[id]/settings`, later documents and billing).
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

### Client address and the proxy

The API rate-limits logins, registrations and public links per client address, taken from `X-Forwarded-For`
and honoured only from `TRUSTED_PROXY_CIDRS`. `web` forwards the header it receives, so whoever sets it
decides the address: an exposed Next server would let a client pick a new "IP" per request and defeat every
limit. Hence the compose topology `browser → proxy (nginx) → web → api`: nginx is the only published HTTP
port, replaces `X-Forwarded-For` with the peer address instead of appending to it, and passes `Host` and
`X-Forwarded-Proto`. It resolves `web` through Docker's DNS on every request (`resolver` plus a variable in `proxy_pass`), so recreating only the `web` container needs no nginx restart; the cost is a new upstream connection per request (no keepalive pool). The same holds for the staging override, which also unpublishes the api port.
If you put another load balancer or TLS terminator in front of nginx, configure nginx `real_ip` for it
(`set_real_ip_from` + `real_ip_header X-Forwarded-For`), otherwise every user shares the balancer's address.

### Error handling on the frontend

Every client turns a failed response into one `ApiError` (`status`, `code`, `message`, `correlationId`,
`fieldErrors`). Query and mutation failures pass through one handler (`lib/api/error-handler.ts`, wired into the
TanStack `QueryCache`/`MutationCache`):

| Case                  | Behaviour                                                                     |
| --------------------- | ----------------------------------------------------------------------------- |
| 401                   | Client refreshes once and retries; if that fails the user is sent to `/login` |
| 403 (query)           | No toast: the screen renders `ForbiddenState`                                 |
| 404 (query)           | No toast: the screen renders its not-found state                              |
| 403 (mutation)        | Toast "You don't have permission to do that"                                  |
| `PLAN_LIMIT_EXCEEDED` | `plan-limit-exceeded` window event for the upgrade dialog; no toast           |
| 429, network, 5xx     | Friendly toast; the correlation id is shown as a reference                    |

`app/error.tsx` and `app/not-found.tsx` cover render-time failures; `EmptyState`, `ErrorState`,
`ForbiddenState` and `LoadingState` are the shared building blocks.

### Running e2e

The Playwright suite (`e2e/`) runs against the production images, not dev servers:

```bash
docker compose up --build --wait proxy worker   # nginx plus web, api, collab, the queue worker (it sends the invitation mail) and the infrastructure
pnpm exec playwright install chromium  # first run only
RATE_REGISTER_PER_HOUR_IP=1000 RATE_LOGIN_PER_MIN_IP=1000 docker compose up -d api   # headroom: all tests share one address
pnpm test:e2e
```

Two more pieces of the stack matter to the workspace specs: Mailpit (the invitation mail is fetched from
`MAILPIT_URL`, default `http://localhost:8025`) and, for the streaming spec, `DASHBOARD_BLOCK_DELAY_MS` on the
`web` container. Set it in the shell that starts compose and keep it in the environment of `pnpm test:e2e`;
the streaming spec skips itself without it:

```bash
DASHBOARD_BLOCK_DELAY_MS=600 docker compose up --build --wait proxy worker
DASHBOARD_BLOCK_DELAY_MS=600 pnpm test:e2e
```

Every test runs from the same address (the proxy overwrites `X-Forwarded-For`), so CI raises the per-IP limits
through the `RATE_*` variables; `client-ip.spec.ts` proves that a spoofed header gets no fresh bucket. Fixtures
create users through the API and reuse the session cookies instead of logging in through the UI. Traces
and videos are kept for failed tests (`test-results/`, `playwright-report/`). CI runs the same steps in the
`e2e` job and uploads both folders as artifacts.

Streaming leaves a hidden copy of a boundary's content in the DOM until React reveals it, and a strict
`getByText`/`getByLabel`/`getByTestId` that runs in that moment fails with a strict-mode violation instead of
retrying. Specs therefore use role-based locators (hidden elements are excluded) for pages that sit behind
`loading.tsx`, and `persisted(page, …)` in `documents.spec.ts` waits for the api call before a reload.

## Decisions

The server side follows the NestJS documentation wherever it fits, and the places where it does not are
listed here with the reason, so that a reader does not have to rediscover them.

### Where the backend uses Nest's own building blocks

- **Configuration:** `@nestjs/config`, validated at start-up against one zod schema; the process environment
  is the only source (`.env.example`, `.env.staging.example`).
- **Dependency injection by type**, with `@Inject()` only for `Symbol` tokens. Feature modules import each
  other explicitly; only infrastructure modules are global (configuration, logger, Redis, queues, metrics,
  health, Prisma).
- **Cross-cutting code** is registered as providers: the validation pipe and the exception filter through
  `APP_PIPE` / `APP_FILTER`, rate limiting through `APP_GUARD`. Access to a document, an attachment or a
  workspace is a guard plus parameter decorators (`@DocumentAccess`, `@AttachmentAccess`,
  `@CurrentDocumentAccess`), not a check inside each service.
- **Queues:** `@nestjs/bullmq` (`@Processor`, `@InjectQueue`), with a base class that restores the correlation
  id of the job.
- **Probes:** `@nestjs/terminus` for `/health` and `/ready`.
- **Rate limiting:** `@nestjs/throttler` with Redis storage; login and ticket limits are guards of their own.
- **Access tokens:** `@nestjs/jwt` in the api.
- **Logging:** `nestjs-pino`; classes inject `PinoLogger` (`@InjectPinoLogger`).
- **Server-sent events:** `@Sse` with an `Observable`, so the heartbeat, the membership check and the cleanup
  on disconnect are part of the stream.
- **WebSocket gateway:** `@WebSocketGateway` on a subclass of `@nestjs/platform-ws`'s `WsAdapter`.

### Where it deliberately does not

| Area                    | What the code does                                                                                                                                                                                                                                               | Why not the stock approach                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collab gateway          | A separate service with its own image. Its internal API (flush, restore, close) is a second Nest application on port `4002` that shares the rooms.                                                                                                               | The assignment asks for a separate collaboration gateway. Port `4002` is never published, which is what protects `restore` and `close`. A hybrid application would also work; it was not needed to get that isolation. |
| WebSocket adapter       | `CollabWsAdapter` extends `WsAdapter` and overrides three things: upgrades are routed by path prefix (`/ws/<documentId>`), message handlers are not bound, and `maxPayload` comes from the configuration.                                                        | The stock adapter matches the exact path and parses every frame as JSON; the `y-websocket` protocol is binary and addresses the document in the path.                                                                  |
| Access token            | The api signs and verifies with `@nestjs/jwt`. The Next.js edge middleware and the short-lived collab ticket use `jose`. A contract test checks that tokens from either side verify on the other.                                                                | The edge runtime cannot run `jsonwebtoken`, and the ticket has a single implementation shared by api and collab, so there is nothing to keep in step.                                                                  |
| CSRF                    | `SameSite=Lax` cookies plus a guard that requires `Origin` to equal `WEB_ORIGIN` on state-changing requests authenticated by cookies.                                                                                                                            | The browser reaches the api through a same-origin rewrite, so the origin check is enough and no token endpoint, header or form field has to be added to every mutation. See [Authentication](#authentication).         |
| Request validation      | class-validator DTOs on the api, zod schemas in `@collab-docs/shared` for the web forms.                                                                                                                                                                         | The DTOs also produce the OpenAPI document; the schemas have to run in the browser. A parity test feeds the same payloads to both and requires the same verdict.                                                       |
| Data access             | `PrismaClient` is injected directly, transactions are passed as `tx`, and the "live document" condition lives in one helper (`LIVE_DOCUMENT`).                                                                                                                   | Prisma Client already is the access layer; a repository on top would repeat its API. There is no `PrismaService extends PrismaClient` either: the client is created by a factory and closed on shutdown.               |
| Raw SQL                 | `SELECT … FOR UPDATE` on the workspace row (plan limits) and `SKIP LOCKED` in the attachment sweeper, per-document advisory locks around the CRDT log, and `UPDATE`/`DELETE … RETURNING` where a revision bump or a batch delete has to be one atomic statement. | Prisma's query API has no row or advisory locks.                                                                                                                                                                       |
| Tree cache              | A small service over Redis; the key carries a version that `INCR` bumps.                                                                                                                                                                                         | `@nestjs/cache-manager` has no atomic increment, so invalidation by version would need the raw client anyway.                                                                                                          |
| Events between services | `ioredis` publish/subscribe with JSON payloads (`perm.changed`, `doc.deleted`, `doc.restored`, the realtime bridge).                                                                                                                                             | `@nestjs/microservices` would wrap every message as `{ pattern, data }` and turn both services into hybrid applications for the same delivery guarantees.                                                              |
| Internal HTTP call      | The api calls collab with the platform `fetch` and `AbortSignal.timeout`.                                                                                                                                                                                        | `@nestjs/axios` adds axios and an `rxjs` wrapper for a single call with a timeout.                                                                                                                                     |
| OpenAPI                 | `@ApiProperty` decorators are written by hand, and `docs/openapi.json` is exported and committed.                                                                                                                                                                | The Nest CLI plugin is optional, saves decorators only, and would change the generated document silently when a type changes.                                                                                          |
| Metrics                 | `prom-client` used directly behind `GET /metrics`.                                                                                                                                                                                                               | The assignment asks for a metrics endpoint; the registry is the library's own, and a wrapper module is not part of the Nest documentation.                                                                             |
| Business event logs     | `logEvent(logger, name, fields)` over the injected logger.                                                                                                                                                                                                       | It writes the name once as the `event` field and once as the message, so every business event has the same shape and carries the correlation id.                                                                       |
| Compiler settings       | `module` and `moduleResolution` are `NodeNext`, not the `commonjs` of the Nest template.                                                                                                                                                                         | `yjs`, `lib0`, `y-protocols` and `jose` are ESM-only; see [Module system](#module-system).                                                                                                                             |
| Tests                   | Integration tests are `*.int.spec.ts` next to the code and run with the same Jest setup (`@swc/jest`); services also have unit tests built with `Test.createTestingModule`.                                                                                      | The name separates them from unit tests without a second directory; `@swc/jest` emits the decorator metadata that type-based injection needs.                                                                          |

### Options that were considered and left for later

- Moving the collab internal API into a hybrid application (`connectMicroservice`) instead of a second
  application. Port isolation is identical today, so this would be a change of mechanism only.
- A `PrismaService` wrapper with lifecycle hooks, if more than one place needs to react to the client's
  start and stop.

## Not done

To be documented.
