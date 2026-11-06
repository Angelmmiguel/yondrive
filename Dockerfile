# syntax=docker/dockerfile:1

# The web app, compiled into web/build for the Go binary to embed. Corepack
# picks the pnpm version pinned in package.json. Install scripts are disabled
# by web/.npmrc, and the lockfile is not allowed to change.
FROM node:22-alpine AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml web/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# The server, statically linked so it can run from scratch. go.sum is copied
# when the module has dependencies, so the build is checked against it.
FROM golang:1.26-alpine AS server
RUN apk add --no-cache ca-certificates
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY api/ api/
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/*.go web/
COPY --from=web /src/web/build web/build
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /yondrive ./cmd/yondrive
# scratch has no shell, so the data directory is made here, owned by the user
# the container runs as.
RUN mkdir /rootfs-data && chown 99:100 /rootfs-data && chmod 700 /rootfs-data

FROM scratch
# The server never dials out for content, but single sign-on will need to
# verify an identity provider's certificate.
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
