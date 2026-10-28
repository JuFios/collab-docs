# API platform

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
  limit (`RATE_GLOBAL_PER_MIN_IP`) applies everywhere; `RateLimit.login()`, `.register()` and `.guestTicket()`
  are per-IP presets whose limits come from the `RATE_*` variables. `RateLimit.user('ticket' | 'publicLink')` counts
  per signed-in user instead (the same throttler and Redis store, keyed by `request.user` in a route-level
  `UserThrottlerGuard`), for what people do rather than what addresses do: collab tickets are fetched on every reconnect of every tab, and a person creating public links
  should not get a fresh budget from another IP. If Redis is unavailable both guards fail open and log the error.
- **OpenAPI**: Swagger UI at `/docs`, JSON at `/docs/json`. `pnpm --filter @collab-docs/api openapi:export`
  writes the committed `docs/openapi.json` (the app is built without connecting to anything).

## Error model

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

## Logging & correlation

Logs are JSON (`nestjs-pino`). Each request gets a correlation id: the incoming `x-correlation-id` if it is a
short, log-safe token, otherwise a new UUID. It is stored in `AsyncLocalStorage`, added to every log line,
returned in the `x-correlation-id` response header and in every error body. When code enqueues a job the id
is written into the job data, and the worker restores it before running the processor, so one id follows a
change from the browser through the API into background work (and later the collab server). Secrets are
redacted from logs (`authorization`, `cookie`, `set-cookie`, passwords, tokens). Classes get their logger by
injection (`@InjectPinoLogger(MyService.name)`), which adds a `context` field; business events are logged with
`logEvent(this.logger, 'document.published', { … })` (an `event` field plus the same name as the message).

## Observability

- `GET /health` — liveness (checks nothing, so a database outage never restarts the container; the Docker
  healthchecks use it). `GET /ready` — readiness: pings Postgres and Redis (2 s each) and answers `503` when one is
  down. Both use the standard `@nestjs/terminus` body, `{ status, info, error, details }`; a failing dependency
  shows up as `{ status: 'down' }` under `error` and `details`, without the underlying error message.
- `GET /metrics` — Prometheus (api and collab, each on its own port): default process metrics plus the series below.
  The route is outside the `/api` prefix and answers only to `Authorization: Bearer <METRICS_TOKEN>` (`401`
  otherwise). That matters most for collab, whose HTTP port is the one browsers open WebSockets on and is therefore
  published; `METRICS_TOKEN` is a required secret like the others (a `dev-only` placeholder in dev, rejected in
  staging).

  | Metric                                                                                                                                                                                                    | Process     | Meaning                                                |
  | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------ |
  | `http_request_duration_seconds{route,method,status}`                                                                                                                                                      | api         | latency by route pattern, not raw URL                  |
  | `queue_jobs{queue,state}`, `queue_jobs_processed_total{queue,result}`, `queue_enqueue_failures_total{queue}`                                                                                              | api, worker | backlog, outcomes, jobs that could not be enqueued     |
  | `tree_cache_lookups_total{result}`                                                                                                                                                                        | api         | document tree cache hits, misses, errors               |
  | `search_index_lag_seconds`, `search_index_pending_documents`                                                                                                                                              | api         | how far the search index is behind                     |
  | `billing_webhook_deliveries_total{result}`                                                                                                                                                                | api         | webhooks by result: new, requeued, duplicate, rejected |
  | `notifications_created_total{type}`                                                                                                                                                                       | api         | in-app notifications                                   |
  | `collab_connections`, `collab_rooms`                                                                                                                                                                      | collab      | open sockets, documents loaded in memory               |
  | `collab_updates_applied_total`, `collab_updates_duplicate_total`, `collab_updates_rejected_total{reason}`                                                                                                 | collab      | what happened to document updates                      |
  | `collab_rate_limited_total`, `collab_ws_close_total{code}`, `collab_access_changes_total{outcome}`                                                                                                        | collab      | abuse limits, close codes, permission re-evaluation    |
  | `collab_persist_duration_seconds`, `collab_persist_failures_total`, `collab_compaction_duration_seconds`, `collab_compaction_rows_total`, `collab_compaction_failures_total`, `collab_bad_log_rows_total` | collab      | durability of the CRDT log                             |

  A scrape configuration for the compose network:

  ```yaml
  scrape_configs:
    - job_name: collab-docs-api
      metrics_path: /metrics
      authorization: { type: Bearer, credentials_file: /etc/prometheus/metrics-token }
      static_configs: [{ targets: ['api:4000'] }]
    - job_name: collab-docs-collab
      metrics_path: /metrics
      authorization: { type: Bearer, credentials_file: /etc/prometheus/metrics-token }
      static_configs: [{ targets: ['collab:4001'] }]
  ```

  Alert on `collab_persist_failures_total` and `queue_enqueue_failures_total` increasing, on `search_index_lag_seconds`
  staying high, on `queue_jobs{state="failed"}` growing, and on `collab_updates_rejected_total{reason!="read_only"}`
  (a client sending what no editor sends).

- **Key events** are structured log lines with an `event` field, the correlation id of the request or job behind them
  and nothing that identifies a credential: `document.published`, `document.unpublished`, `public_link.revoked`,
  `plan.changed`, `webhook.duplicate_delivery`, `webhook.signature_rejected`, `collab.update_rejected`,
  `collab.connected`, `search.indexed`, `revalidate.sent`, `revalidate.failed`, `auth.login_failed`,
  `auth.refresh_reuse_detected`, `queue.job_failed`. The e2e suite (`observability.spec.ts`) reads the container logs
  and checks that these appear, in this format, and that no password or session token is in any service's output.
- **One correlation id, five hops.** `web` middleware accepts or issues the id and sends it on with every server-side
  call; the api puts it on its lines and in the job data; the worker restores it before the processor runs; the
  collab ticket carries it, and collab logs it as `ticketCorrelationId` on the lines of that socket. The same spec
  sends a request with a known id through the page, the api, the queue, the worker and a WebSocket and finds it in each
  service's log.

## Queues

BullMQ queues (`search-sync`, `public-revalidate`, `mail`, `billing-webhook`, `billing-delivery`, `link-expiry`, `version-prune`, `attachment-cleanup`)
are registered once with `@nestjs/bullmq` (`BullModule.registerQueue`), with default retries (5 attempts,
exponential backoff) and bounded history. Producers inject a queue (`@InjectQueue(name)`) or use `QueueService`;
either way `addJob` stamps the ambient correlation id into the job. Consumers are `@Processor(name)` classes that
extend `QueueProcessor`: it restores the correlation context, counts results and logs failed jobs, and the class
only implements `handle(job)`. The worker runs from the same image as the API (`node dist/main.worker.js`) and
shuts down gracefully, finishing active jobs. `enqueueDebounced(queue, documentId, delayMs)` coalesces bursts of
changes into one delayed job using BullMQ deduplication; the job reads the latest state when it runs, and a
change made while it is processing schedules a new job. A fixed `jobId` per document is deliberately not
used, because BullMQ remembers finished ids and would drop later changes.
