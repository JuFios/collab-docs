# syntax=docker/dockerfile:1
# The upstream MinIO and mc images are no longer published, so both are built from the
# last tagged source releases. The server and the client ship in one image.
FROM golang:1.25-bookworm AS build
ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z
ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
  GOBIN=/out go install -trimpath -ldflags="-s -w" github.com/minio/minio@${MINIO_VERSION} \
  && GOBIN=/out go install -trimpath -ldflags="-s -w" github.com/minio/mc@${MC_VERSION}

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --create-home minio \
  && mkdir /data && chown minio:minio /data
COPY --from=build /out/minio /out/mc /usr/local/bin/
USER minio
VOLUME /data
EXPOSE 9000 9001
CMD ["minio", "server", "/data", "--console-address", ":9001"]
