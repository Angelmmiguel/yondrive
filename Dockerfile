# syntax=docker/dockerfile:1

# The build is reproducible: the same commit, with the same VERSION, COMMIT and
# SOURCE_DATE_EPOCH, gives the same binary here as `just build` gives in the
# Nix shell. That holds because both use the same Go and Node releases (the
# base images below are pinned to the versions in flake.lock, by digest) and
# the same build flags. `just verify-reproducible docker=true` checks it.
ARG VERSION=dev
ARG COMMIT=unknown
ARG SOURCE_DATE_EPOCH=0

# The web app, compiled into web/build for the Go binary to embed. Corepack
# picks the pnpm version pinned in package.json. Install scripts are disabled
# by web/.npmrc, and the lockfile is not allowed to change.
FROM node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
# The commit names the SvelteKit build (svelte.config.js), in place of the time.
ARG COMMIT
ARG SOURCE_DATE_EPOCH
RUN YONDRIVE_COMMIT=${COMMIT} SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} pnpm build

# The server, statically linked so it can run from scratch, with the flags of
# `just build`.
FROM golang:1.26.10-alpine@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696 AS server
RUN apk add --no-cache ca-certificates
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY api/ api/
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/*.go web/
COPY --from=web /src/web/build web/build
ARG VERSION
ARG COMMIT
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false \
    -ldflags="-s -w -buildid= -X main.version=${VERSION} -X main.commit=${COMMIT}" \
    -o /yondrive ./cmd/yondrive
# scratch has no shell, so the data directory is made here, owned by the user
# the container runs as.
RUN mkdir /rootfs-data && chown 99:100 /rootfs-data && chmod 700 /rootfs-data

# The binary alone, for comparing it with one built elsewhere:
#   docker build --target binary --output type=local,dest=out .
FROM scratch AS binary
COPY --from=server /yondrive /yondrive

FROM scratch
# The server never dials out for content, but single sign-on has to verify an
# identity provider's certificate. YONDRIVE_CA_FILE adds an internal authority.
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=server /yondrive /yondrive
COPY --from=server --chown=99:100 /rootfs-data /data
# nobody:users, the owner Unraid gives appdata. The data directory is written
# 0700 and 0600, so the mounted /data must belong to this uid.
USER 99:100
ENV YONDRIVE_ADDR=:8080 YONDRIVE_DATA=/data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/yondrive", "serve"]
