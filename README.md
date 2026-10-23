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
| `apps/collab`     | NestJS real-time collaboration server (`GET /health`).                  |
| `packages/shared` | Shared code with entry points `.`, `./content` and `./nest`.            |
| `packages/db`     | Database package (placeholder).                                         |

`@collab-docs/shared/nest` is server-only; ESLint forbids importing it (and `@collab-docs/db`) in
`apps/web`.

## Run

Requires Node.js >= 22.12 (see `.nvmrc`) and pnpm 10.

```bash
pnpm install
pnpm dev
```

Services listen on `3000` (web), `4000` (api) and `4001` (collab).

## Development

| Command                   | What it does                                |
| ------------------------- | ------------------------------------------- |
| `pnpm lint`               | ESLint (flat config) for the whole repo     |
| `pnpm typecheck`          | `tsc --noEmit` in every package             |
| `pnpm test`               | Jest (api, collab) and Vitest (web, shared) |
| `pnpm build`              | Builds shared libraries, then every app     |
| `pnpm format`             | Prettier                                    |
| `pnpm --filter api start` | Runs the built API                          |

Libraries in `packages/*` are built before type checking and testing (`pnpm build:libs`, run
automatically by `typecheck` and `test`).

### Module system

`jose` is ESM-only, so the choice below was verified with smoke tests in every runtime:

- `packages/shared` is a dual package (`"type": "module"`, built with tsup to ESM `.js` and CJS
  `.cjs`, with matching type declarations) exposed through conditional `exports`.
- `apps/api` and `apps/collab` stay CommonJS (NestJS). At runtime Node loads ESM-only `jose`
  through `require(esm)`, which is why Node >= 22.12 is required.
- Jest runs through `@swc/jest`; `transformIgnorePatterns` lets `jose` be transformed to CommonJS.
- Vitest (web, shared) and `next build` import the package natively as ESM.

## Decisions

To be documented.

## Not done

To be documented.
