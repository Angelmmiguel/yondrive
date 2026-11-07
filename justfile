# Development commands. Run them inside the Nix shell (`nix develop`, or let
# direnv load it for you).

# Private overrides such as YONDRIVE_ADDR live in .env.local (gitignored).
# just loads it on every run, so a change takes effect without re-entering the
# shell; variables already set in the environment win.
set dotenv-load := true
set dotenv-filename := ".env.local"

default: test

# Run the server against ./data.
serve *args:
    go run ./cmd/yondrive serve --data ./data {{args}}

# Run the Go server and the Vite dev server together, until Ctrl-C.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    just serve &
    just web-dev &
    trap 'kill 0' EXIT INT TERM
    wait -n

# Run the Go and web test suites.
test: web-test
    go test -race ./...

# Vet and lint everything.
lint: web-check
    redocly lint --config api/redocly.yaml api/openapi.yaml
    go vet ./...
    golangci-lint run

# Build the binary into bin/, with the web app embedded.
build: web-build
    go build -o bin/yondrive ./cmd/yondrive

# Build the container image for linux/amd64, the platform Unraid runs. The
# Dockerfile builds the web app and the binary itself, so nothing here
# depends on a prior `just build`.
image version="latest":
    docker build --platform linux/amd64 --build-arg VERSION={{version}} -t ghcr.io/angelmmiguel/yondrive:{{version}} -t ghcr.io/angelmmiguel/yondrive:latest .

# Report files that gofmt would change.
fmt:
    git ls-files '*.go' | xargs gofmt -l

# Regenerate the Go and TypeScript code from api/openapi.yaml, after linting it.
api: web-install
    redocly lint --config api/redocly.yaml api/openapi.yaml
    oapi-codegen -config api/oapi-codegen.yaml api/openapi.yaml
    cd web && pnpm api

# Fail if the generated code differs from what the spec produces, as CI does.
api-check: api
    #!/usr/bin/env bash
    set -euo pipefail
    git diff --exit-code -- internal/api web/src/lib/api
    [ -z "$(git ls-files --others --exclude-standard internal/api web/src/lib/api)" ]

# Web

# Install the web app's dependencies exactly as the lockfile pins them.
[working-directory('web')]
web-install:
    pnpm install --frozen-lockfile

# Serve the app on :5173, proxying /api to the Go server (YONDRIVE_ADDR, default :8080).
[working-directory('web')]
web-dev:
    pnpm dev

# Type-check, lint and check the formatting of the web app.
[working-directory('web')]
web-check:
    pnpm check
    pnpm lint

# Run the web test suite.
[working-directory('web')]
web-test:
    pnpm test

# End-to-end tests: the account flows in vitest, then the Playwright specs
# in a real browser against the built app the binary embeds. Each file starts
# its own throwaway Go server over a temporary data directory (web/tests/
# server.ts), so nothing here depends on a port or a data path. The browsers
# come from the flake (PLAYWRIGHT_BROWSERS_PATH).
[working-directory('web')]
web-e2e: web-build
    pnpm test:e2e

# Compile the app into web/build, where the Go binary embeds it from. The
# build script recreates build/.gitkeep afterwards: adapter-static wipes the
# directory, and the Go embed needs the placeholder present on a clean
# checkout.
[working-directory('web')]
web-build:
    pnpm build
