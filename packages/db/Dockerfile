# syntax=docker/dockerfile:1
# One-shot migration image: applies migrations and (APP_ENV=dev only) seeds. Build context: repository root.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN npm install -g pnpm@10.26.1
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch

FROM fetch AS deps
# manifests only: the install layer is rebuilt when a dependency changes, not when a source file does
COPY package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/collab/package.json apps/collab/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/nest/package.json packages/nest/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile --filter @collab-docs/db...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/db packages/db
# dev dependencies are kept: the Prisma CLI, tsx and the seed's hashing library are needed at runtime
RUN --mount=type=cache,id=pnpm-metadata,target=/root/.cache/pnpm \
    pnpm --filter @collab-docs/db build \
  && pnpm --filter @collab-docs/db deploy --legacy --prefer-offline /out

FROM node:24-bookworm-slim AS runtime
ENV APP_ENV=dev
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node_modules/.bin/tsx prisma/seed.ts"]
