# Development

## Image builds

Each image installs only the workspace packages it needs (`pnpm install --filter <app>...`) from the manifests alone, so
the install layer is rebuilt when a dependency changes and not when a source file does. The libraries (`shared`, `nest`,
`db`) are built in a layer of their own, before the app. `.dockerignore` lets only the manifests, `apps/` and `packages/`
into the build context, so a change to tests, docs or workflows rebuilds nothing. `pnpm deploy --legacy` resolves the
production tree again; its metadata is kept in a build cache mount so that it does not go to the registry every time.
After a change to the lockfile all images rebuild; after a change to one app only that image does.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

| Job              | What it does                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint-typecheck` | ESLint and `tsc` for every package and for `e2e/`                                                                                                   |
| `unit`           | Jest (api, collab) and Vitest (web, shared, nest); no services needed                                                                               |
| `integration`    | Migrations apply and match `schema.prisma`, integration tests against Postgres, Redis and the compose `minio` image, `docs/openapi.json` is current |
| `e2e`            | Playwright against the compose stack (see [Running e2e](testing.md#end-to-end)); depends on `lint-typecheck`                                        |
| `docker-build`   | Images for `web`, `api`, `collab`, `migrate` and `minio`; writes the layer cache the other jobs reuse                                               |
| `web-bundle`     | The published page stays free of the editor's JavaScript                                                                                            |
| `audit`          | `pnpm audit --prod`                                                                                                                                 |

The `unit` and `integration` jobs print a coverage table in the job summary and keep the reports as artifacts. It is
informational: no threshold fails a build (set `COVERAGE=1` to get the same reports locally).

The `e2e` job retries a failed test once. A test that passes only on the retry is listed in the job summary with
the first failure (`.github/scripts/flaky-report.mjs`), so a flake is investigated and fixed rather than hidden.

## Commands

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

## Module system

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
