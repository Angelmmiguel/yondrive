# YonDrive

Self-hosted files, documents and notes with zero-knowledge encryption. The
server stores and serves content without ever processing it; the browser does
the parsing, editing, indexing and, in end-to-end mode, the encryption.

[README.md](README.md) is the product description and [PLAN.md](PLAN.md) holds
the decisions, the architecture and the delivery phases. Consult PLAN.md when a
task touches storage, crypto, the API contract or a phase's scope, and update
the docs (PLAN.md, README.md, `docs/`, `api/openapi.yaml`) in the same change
that alters what they describe.

## Stack

- **Backend:** Go 1.26, `net/http`, `log/slog`, `crypto/*`. Dependencies stay few
  and deliberate (see PLAN.md 5.1); no web framework. Module
  `github.com/Angelmmiguel/yondrive`, binary `yondrive` with a `serve`
  subcommand.
- **API:** OpenAPI 3.1, written by hand in `api/openapi.yaml`, served at
  `/api/openapi.yaml` from the binary and versioned under `/api/v1`. `just api`
  lints it and regenerates `internal/api` (oapi-codegen: types and the
  `net/http` strict server interface) and `web/src/lib/api/schema.ts`
  (openapi-typescript). Never edit generated files; CI fails when they drift.
  Change the spec first, then implement the generated interface. Errors are JSON
  `{"code": "<stable_code>"}`, never free-form messages.
- **Frontend:** SvelteKit SPA in `web/`, compiled by adapter-static into
  `web/build`, which the Go binary embeds. In development Vite proxies `/api`
  to the Go server, so there is no CORS.
  - Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`). Never
    `export let`, `$:` or `svelte/store`. Shared reactive state lives in
    `.svelte.ts` modules under `src/lib/state`, exported as class instances or
    objects whose properties are `$state`. When unsure about an idiom, check
    https://svelte.dev/docs.
  - The API client in `src/lib/api` mirrors the Go routes one to one and knows
    nothing about crypto.
  - Components draw and own their own interactions. Routes are thin glue that
    composes components and calls the layers below, with no business logic.
  - Visual language comes from `src/lib/styles/tokens.css`: primitives (never
    used in a component) and a semantic layer written once with `light-dark()`.
    Components read semantic tokens only. App accents: Drive blue, Sheets green,
    Notes amber. Fonts (Geist, Geist Mono, Source Serif 4) are self-hosted
    through `@fontsource`; nothing is loaded from another origin.
  - The theme preference is kept in `localStorage` under `yondrive-theme`.
  - The Content-Security-Policy is authored in `svelte.config.js` and delivered
    as a header by the Go handler in `web/embed.go`, which reads it from the
    built `index.html`. `connect-src 'self'` stays: content never leaves for
    another origin.
- **Toolchain:** Nix flake. Run every command inside `nix develop` (or direnv);
  the machine may have no Go or Node on PATH.

## Commands

```
just test       # go test -race ./... and vitest
just lint       # go vet, golangci-lint, redocly, svelte-check, eslint, prettier
just dev        # Go server on :8080 and Vite on :5173 together
just build      # pnpm build, then go build with the web app embedded
just api        # lint the spec, regenerate Go and TypeScript code
just api-check  # fail if generated code is out of date (CI)
just web-e2e    # Playwright specs against throwaway servers
just image      # container image
just dist       # release binaries for linux and darwin, and the web app's hashes
just api-docs   # render the API reference into docs/api/
just verify-reproducible  # build twice from scratch and compare (docker=true: and the Dockerfile)
just release X.Y.Z  # date the changelog, commit, sign and push the tag (docs/RELEASE.md)
```

`just test` and `just lint` must be clean, and `just fmt` must print nothing,
before work is done. Run `just web-e2e` when a change touches a screen. The
browser specs run against `web/build`, so `just web-e2e` builds first. Web-only
variants exist as `web-install`, `web-dev`, `web-check`, `web-test`,
`web-build`. Private overrides (such as `YONDRIVE_ADDR`) go in `.env.local`.

`@playwright/test` in `web/package.json` must be the exact version of
`playwright-driver` in the flake. pnpm installs use `--frozen-lockfile`, with
install scripts disabled and a minimum release age (`web/.npmrc`). Runtime
dependencies are pinned to exact versions.

## Conventions

- Security first. The server never processes content. Validate ids and paths
  before touching the filesystem, compare secrets in constant time, never log
  tokens, keys, names or bodies, keep writes atomic. Believe forwarded headers
  only from `YONDRIVE_TRUSTED_PROXIES`. In end-to-end mode no feature may need
  the server to read content, names, tags or search terms.
- Concise, idiomatic Go. Doc comments on exported identifiers; other comments
  only where the why is non-obvious. No narration comments, no abstractions
  with a single caller, no utils packages.
- Sentinel errors live in the package that owns the concept; wrap with `%w`.
- Every route has tests, run with the race detector. Every client function and
  state module has a vitest test.
- Update the docs in the same change as the code they describe.
- Do not commit without an explicit request.
