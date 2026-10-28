# syntax=docker/dockerfile:1
# Build context: repository root (docker build -f apps/api/Dockerfile .)
FROM node:24-bookworm-slim AS base
# Prisma looks for libssl when it generates the client and runs the schema engine; the slim image has none
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
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
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --offline --frozen-lockfile --filter @collab-docs/collab...

FROM deps AS build
COPY tsconfig.base.json ./
# the libraries first: they change less often than the app, so a change to the app reuses their build
COPY packages/shared packages/shared
COPY packages/nest packages/nest
COPY packages/db packages/db
RUN pnpm --filter @collab-docs/shared build \
  && pnpm --filter @collab-docs/nest build \
  && pnpm --filter @collab-docs/db build
COPY apps/collab apps/collab
# `deploy --legacy` resolves the production tree again; the metadata cache keeps that from going to the registry on every build
RUN --mount=type=cache,id=pnpm-metadata,target=/root/.cache/pnpm \
    pnpm --filter @collab-docs/collab build \
  && pnpm --filter @collab-docs/collab deploy --legacy --prod --prefer-offline /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 4001
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4001)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
