# Testing

## Unit and integration

```bash
pnpm test                 # unit: Jest (api, collab), Vitest (web, shared, nest); no services needed
docker compose up -d postgres redis minio minio-init mailpit
DATABASE_URL=postgresql://collab:dev-only-postgres-password@localhost:5432/collab \
  MAILPIT_URL=http://localhost:8025 pnpm test:integration
```

Integration tests are `*.int.spec.ts` next to the code. Each Jest worker creates its own throwaway database on the
server in `DATABASE_URL`, applies the migrations and truncates tables between tests (`createTestDb()` from
`@collab-docs/db/testing`). Without `MAILPIT_URL` the email delivery test is skipped.

The tests that matter most for the assignment: permission resolution including sharing
(`packages/shared`, `apps/api/src/permissions`), the IDOR matrix (`apps/api/src/security/idor.int.spec.ts`), CRDT
application, merge and idempotent re-delivery of an update (`apps/collab/src/ws/collab.int.spec.ts`,
`apps/collab/src/store`), billing webhook idempotency (`apps/api/src/billing`), and revalidation after a save.

## End to end

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
create users through the API and reuse the session cookies instead of logging in through the UI. Shared helpers (`e2e/workspace.ts`) create workspaces and documents and accept invitations; `e2e/collab-client.ts` is a raw `y-websocket` peer for tests that must bypass the editor (a viewer writing over the socket). Traces
and videos are kept for failed tests (`test-results/`, `playwright-report/`). CI runs the same steps in the
`e2e` job and uploads both folders as artifacts.

Waiting is done on the thing that changes, never on the clock: `expect.poll` on the api, on the page or on the
structured log lines of a container (`e2e/logs.ts`). `waitForTimeout` is not used; the one fixed delay the stack
needs (`DASHBOARD_BLOCK_DELAY_MS`) is a setting of the product under test, not a guess in a test. Caret
movement in the editor specs goes through `placeCaret`, because keys such as Home and End behave differently
per platform.

What the suite covers beyond the happy paths: a Viewer refused on every write path (UI, REST including version
restore, publishing and delete, and a raw WebSocket update, confirmed by the collab log); two editors typing at the
same time, with one of them offline and with both offline; publishing blocked while the editor holds unsaved
changes; a document deleted while it is open; the plan limit, the upgrade and a webhook delivered twice; search
that respects access; a mention that reaches its addressee; and the error state of every panel that reads its own
data (`states.spec.ts`). The same two-client scenarios run without a browser in
`apps/collab/src/ws/collab.int.spec.ts` (two `y-websocket` clients, a duplicated update, both clients disconnected).
`apps/web/app/route-states.test.ts` fails when a page is added without a loading state or an error boundary.

Streaming leaves a hidden copy of a boundary's content in the DOM until React reveals it, and a strict
`getByText`/`getByLabel`/`getByTestId` that runs in that moment fails with a strict-mode violation instead of
retrying. Specs therefore use role-based locators (hidden elements are excluded) for pages that sit behind
`loading.tsx`, and `persisted(page, …)` in `documents.spec.ts` waits for the api call before a reload.
