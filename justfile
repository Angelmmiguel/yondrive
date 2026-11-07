# Development commands. Run them inside the Nix shell (`nix develop`, or let
# direnv load it for you).

# Private overrides such as YONDRIVE_ADDR live in .env.local (gitignored).
# just loads it on every run, so a change takes effect without re-entering the
# shell; variables already set in the environment win.
set dotenv-load := true
set dotenv-filename := ".env.local"

# What a build is stamped with, all from git so that the same commit always
# builds the same bytes. The Dockerfile and the release workflow are given the
# same values. SOURCE_DATE_EPOCH is the commit's time, for any tool that would
# otherwise write the current one.
export YONDRIVE_VERSION := env("YONDRIVE_VERSION", `git describe --tags --match 'v[0-9]*' --dirty 2>/dev/null | sed 's/^v//' | grep . || echo dev`)
export YONDRIVE_COMMIT := env("YONDRIVE_COMMIT", `git rev-parse HEAD 2>/dev/null || echo unknown`)
export SOURCE_DATE_EPOCH := env("SOURCE_DATE_EPOCH", `git log -1 --format=%ct 2>/dev/null || echo 0`)

# The flags of every release build: no cgo, no paths of the machine that built
# it, no VCS stamp (the commit is set explicitly) and no build id. The
# Dockerfile repeats them; `just verify-reproducible` checks the two agree.
go_build := 'CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags="-s -w -buildid= -X main.version=$YONDRIVE_VERSION -X main.commit=$YONDRIVE_COMMIT"'

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

# Build the binary into bin/, with the web app embedded, and write the hashes
# of the files it serves beside it.
build: web-build
    {{go_build}} -o bin/yondrive ./cmd/yondrive
    bin/yondrive assets > bin/web-bundle.sha256
    bin/yondrive version

# Build the committed tree twice, each in a clean directory of its own with a
# fresh Go build cache, and fail unless the binaries and the web app's hashes
# are identical. With docker=true, also build the Dockerfile's binary from a
# third copy and compare it with the other two. Uncommitted changes are not in
# any of these builds.
verify-reproducible docker="false":
    #!/usr/bin/env bash
    set -euo pipefail
    work=$(mktemp -d)
    trap 'chmod -R u+w "$work"; rm -rf "$work"' EXIT
    echo "commit $YONDRIVE_COMMIT, version $YONDRIVE_VERSION, SOURCE_DATE_EPOCH $SOURCE_DATE_EPOCH"
    for side in a b; do
        mkdir "$work/$side"
        git archive HEAD | tar -x -C "$work/$side"
        echo "building in $work/$side"
        (cd "$work/$side" && GOCACHE="$work/gocache-$side" just web-install build) > "$work/$side.log" 2>&1 \
            || { tail -n 40 "$work/$side.log"; exit 1; }
    done
    sha256sum "$work"/{a,b}/bin/yondrive "$work"/{a,b}/bin/web-bundle.sha256
    cmp "$work/a/bin/web-bundle.sha256" "$work/b/bin/web-bundle.sha256"
    cmp "$work/a/bin/yondrive" "$work/b/bin/yondrive"
    if [ "{{docker}}" = "true" ]; then
        mkdir "$work/c"
        git archive HEAD | tar -x -C "$work/c"
        docker build --platform linux/amd64 --target binary --output "type=local,dest=$work/docker" \
            --build-arg VERSION="$YONDRIVE_VERSION" --build-arg COMMIT="$YONDRIVE_COMMIT" \
            --build-arg SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" "$work/c"
        sha256sum "$work/docker/yondrive"
        cmp "$work/a/bin/yondrive" "$work/docker/yondrive"
    fi
    echo "reproducible: $(sha256sum < "$work/a/bin/yondrive" | cut -d' ' -f1)"
    "$work/a/bin/yondrive" version

# Build the container image for linux/amd64, the platform Unraid runs. The
# Dockerfile builds the web app and the binary itself, so nothing here
# depends on a prior `just build`.
image version="latest":
    docker build --platform linux/amd64 --build-arg VERSION={{version}} --build-arg COMMIT=$YONDRIVE_COMMIT --build-arg SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH -t ghcr.io/angelmmiguel/yondrive:{{version}} -t ghcr.io/angelmmiguel/yondrive:latest .

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
