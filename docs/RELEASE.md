# Releases

How a release is built, what it publishes, and how anyone can check it: that a
download is what the release workflow built, that it was built from the tagged
source, and that the app a server hands your browser is the one the release
contains.

## What a release publishes

Pushing a tag `vX.Y.Z` runs [`.github/workflows/release.yml`](../.github/workflows/release.yml).
Before anything else it checks the tag: it must be `vX.Y.Z` or a pre-release
`vX.Y.Z-something`, on a commit that is on `main`, and `CHANGELOG.md` must have a
dated section for the version (a pre-release takes the section of the version it
leads to, which may still say Unreleased). Then it runs the whole CI suite on the
tagged commit (the same workflow every push to `main` runs) and builds nothing
unless that passes. Then it publishes:

| Artifact | What it is |
| --- | --- |
| `yondrive-linux-amd64`, `yondrive-linux-arm64`, `yondrive-darwin-amd64`, `yondrive-darwin-arm64` | Static binaries, web app embedded, from `just dist` |
| `web-bundle.sha256` | The SHA-256 of every file of the embedded web app, as `yondrive assets` prints it. Its own SHA-256 is the web app's **root hash** |
| `yondrive-go.spdx.json` | SBOM of the Go modules linked into the binary, read from its build information |
| `yondrive-web.spdx.json` | SBOM of every package in `web/pnpm-lock.yaml`. The lockfile does not tell build-time tools from what ships, so it lists both; only the runtime dependencies in [PLAN.md 5.10](../PLAN.md#510-third-party-licences) end up in the app |
| `yondrive-api-reference.html` | The API reference rendered from the release's spec ([API.md](API.md)) |
| `SHA256SUMS` | Hashes of all of the above |
| `SHA256SUMS.sigstore.json` | Keyless signature over `SHA256SUMS` |
| `ghcr.io/angelmmiguel/yondrive:X.Y.Z` (also `X.Y` and `X`, except for a pre-release) | The image, for `linux/amd64` and `linux/arm64`, signed by digest. A release never moves `latest` |
| Build provenance | SLSA provenance for every file in `SHA256SUMS` and for the image, kept by GitHub and pushed beside the image |

The signatures are **keyless**: cosign gets a short-lived certificate from
Sigstore for the workflow's GitHub OIDC identity, which names the repository,
the workflow file and the tag, and records the signature in the public
transparency log. There is no signing key to steal or lose. What you verify is
"this was signed by `release.yml` of `Angelmmiguel/yondrive` running for tag
`vX.Y.Z`".

A pre-release is published the same way, marked as a pre-release on GitHub and
not as the latest release.

Pushes to `main` publish `ghcr.io/angelmmiguel/yondrive:latest` for
`linux/amd64` from `ci.yml`, unsigned, reporting a version such as
`0.0.0-main+<commit>`. Use a release tag for anything you rely on.

**What signs, and what does not.** Building runs the web app's dependencies:
Vite and its plugins run code from `node_modules` whatever `ignore-scripts` says.
So the jobs that build (`binaries`, `image`) have no OIDC token and cannot sign,
and the jobs that sign (`sign`, `sign-image`) build nothing: they download what
was built, install cosign from the flake, and sign. A compromised dependency can
still change what it builds, which the reproducible build lets anyone detect
below, but it cannot sign as this workflow or rewrite `dist/` after it was
hashed. Every action is pinned by commit, and checkouts keep no credentials.

## Verifying a download

The tools are `sha256sum`, [cosign](https://docs.sigstore.dev/) and the GitHub
CLI (`gh`); the flake's `release` shell has cosign (`nix develop .#release`).
Replace `1.0.0` with the release.

```bash
V=1.0.0
gh release download "v$V" -R Angelmmiguel/yondrive -D "yondrive-$V" && cd "yondrive-$V"

# 1. The list of hashes was signed by the release workflow, for this tag.
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/Angelmmiguel/yondrive/.github/workflows/release.yml@refs/tags/v$V" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# 2. The files are the ones it lists.
sha256sum -c SHA256SUMS

# 3. GitHub's provenance: built by release.yml of this repository, for this tag.
gh attestation verify yondrive-linux-amd64 -R Angelmmiguel/yondrive \
  --signer-workflow Angelmmiguel/yondrive/.github/workflows/release.yml \
  --source-ref "refs/tags/v$V"
```

The image:

```bash
cosign verify "ghcr.io/angelmmiguel/yondrive:$V" \
  --certificate-identity "https://github.com/Angelmmiguel/yondrive/.github/workflows/release.yml@refs/tags/v$V" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify "oci://ghcr.io/angelmmiguel/yondrive:$V" -R Angelmmiguel/yondrive \
  --signer-workflow Angelmmiguel/yondrive/.github/workflows/release.yml \
  --source-ref "refs/tags/v$V"

# The binary inside is the published one: the image cross-compiles it exactly
# as `just dist` does.
docker create --name yd "ghcr.io/angelmmiguel/yondrive:$V"
docker cp yd:/yondrive ./yondrive-from-image && docker rm yd
sha256sum yondrive-from-image yondrive-linux-amd64   # on an amd64 machine
```

Pin the image by the digest `cosign verify` printed (`image@sha256:…`) rather
than by tag if you want the same bytes next time.

## Rebuilding from source

The build is reproducible: the same commit gives the same bytes, whoever builds
it. To check a release, rebuild it and compare with `SHA256SUMS`:

```bash
git clone https://github.com/Angelmmiguel/yondrive && cd yondrive
git checkout "v$V"
nix develop -c just web-install
nix develop -c just dist
cd dist && sha256sum -c ../../yondrive-$V/SHA256SUMS --ignore-missing
```

The four binaries and `web-bundle.sha256` must match. (The SBOMs and the
signature are not part of the build and carry their own times.)

What makes it reproducible:

- **The stamp comes from git.** The version is `git describe` of the tag, the
  commit is `git rev-parse HEAD`, and `SOURCE_DATE_EPOCH` is the commit's time.
  The release workflow sets the same three.
- **The web app** is built from `web/pnpm-lock.yaml` with a frozen lockfile.
  (The minimum release age in `web/.npmrc` acts when a dependency is added or
  updated; a frozen install takes the lockfile as it is and does not apply it.)
  SvelteKit would name each build after the time it ran; `svelte.config.js`
  names it after the commit instead. Nothing else in the output depends on the
  time or the machine (no absolute paths, no random ids).
- **The Go binary** is built with `-trimpath`, without cgo, without a VCS stamp or
  a build id, and with **the official Go release** of the version the flake pins.
  nixpkgs patches its own Go to look for time zones, MIME types and service names
  under `/nix/store`, which writes store paths into every binary; `just
  release-go` fetches the unmodified release through Go's module proxy, checked
  against Go's checksum database, and every release build uses it.
- **The Dockerfile** uses Go and Node images pinned by digest to the same
  releases, the same flags, and cross-compiles on the build machine, so the
  binary in the image is byte-identical to `dist/yondrive-linux-*`.

`just verify-reproducible` builds the committed tree twice in fresh directories,
with fresh Go build caches, and compares the binaries and the hash lists;
`just verify-reproducible docker=true` builds the Dockerfile's binary as well and
compares it with them. Only the binary is claimed reproducible from the
Dockerfile: the image also holds Alpine's CA bundle at the time of the build,
which is not pinned.

## Checking the app your browser runs

In end-to-end mode the server never sees your keys or your content, but it does
serve the JavaScript that handles them. A server that has been compromised, or
an operator who wants to, could serve a modified app that sends your
passphrase away. Nothing in a browser can prevent that: there is no way for a
web page to prove to you which code it is. What the release gives you is a way
to **detect** it, by comparing what a server serves with what the release
built.

From weakest to strongest:

1. **What the server says.** `GET /api/v1/health` reports `version`, `commit` and
   `web_bundle`, the root hash of the app the binary embeds, and the admin
   Server tab shows them. Compare `web_bundle` with the release's:

   ```bash
   curl -s https://drive.example.com/api/v1/health | jq -r .web_bundle
   sha256sum web-bundle.sha256    # from the verified release
   ```

   This only says what the server *claims*. A server that lies about the app it
   serves will lie here too. It catches honest mistakes: an old image, a
   development build, a mixed-up tag.

2. **What the server serves.** `yondrive assets check` downloads every file the
   list names from the server and compares its SHA-256. Use a binary you have
   verified (any platform will do) and the release's list:

   ```bash
   ./yondrive-linux-amd64 assets check --manifest web-bundle.sha256 https://drive.example.com
   ```

   It prints `DIFFERS` or `FAILED` for each file that does not match and exits
   non-zero. It follows no redirect, so give it the address the app is served
   at (`https://`, not one that redirects there). It also fetches the shell at
   `/signin` and `/s/x`, since the server serves it at every path that is not a
   file, and prints the root the server claims in `/api/v1/health`, failing if
   that is not the list's. This checks the bytes, not a claim. Because `index.html` names the
   entry scripts by their hashed names and those import the rest by theirs, a
   matching set means the code the app starts with is the release's. It does
   not see files that are served but not listed, which the release's app never
   loads.

3. **What your browser received.** The check above is a separate client. A
   server that singles out a person, a browser or a moment could serve the real
   app to the checker and another one to you. To check a browser's own copy,
   open the developer tools on the app, save the network log as HAR, and
   compare the bodies of the scripts it loaded with `web-bundle.sha256`; or, in
   Chromium, look at the hashed names under `_app/immutable/` in the Sources
   panel and compare the files they hold. This is tedious, which is the point
   of saying it plainly: the web cannot offer a check that is both strong and
   easy.

Run 2 after every upgrade, and from time to time; run it from a machine that is
not the server. A mismatch is worth stopping for. A match is good evidence that
the server serves the release, not proof that it always will.

The same limit is in [SECURITY.md](SECURITY.md). Native clients, which carry
their own code, are the way past it.

## Cutting a release

For maintainers.

1. Make sure `main` is green, and that `just verify-reproducible docker=true`
   passes on the commit to release.
2. In `CHANGELOG.md`, turn `## [X.Y.Z] - Unreleased` into `## [X.Y.Z] - YYYY-MM-DD`,
   and commit to `main`. The workflow's first job refuses a tag whose section is
   missing or still marked unreleased, and every job that builds or publishes
   waits for it, so nothing is published.
3. Tag that commit `vX.Y.Z` and push the tag. Nothing else starts a release. A
   tag on a commit that is not on `main`, or one that is not `vX.Y.Z` or
   `vX.Y.Z-pre`, stops at the same first job.
4. Approve the `release` environment's deployments when the workflow asks (the
   jobs that push the image, sign, and make the GitHub release each wait for it;
   approve them together).
5. When the workflow has finished, verify the release as above, from a clean
   machine, including the rebuild. If anything fails, delete the release and the
   image tags, fix it, and release the next patch version rather than moving the
   tag.

What can only be checked by pushing a tag: the keyless signatures and the
provenance (they need GitHub's OIDC token), the `release` environment's approval,
the multi-platform image push and its index annotations, and the GitHub release
itself. Everything they sign or package is built by `just dist` and the
Dockerfile, which run locally.

### Repository settings the workflow relies on

The workflow checks what it can, but who may push a `v*` tag, and who approves a
release, are settings of the repository, which only its owner can change:

1. **A tag ruleset.** Settings > Rules > Rulesets > New ruleset > New tag ruleset.
   Name it `release tags`, Enforcement status Active, Target tags: Add target >
   Include by pattern `v*`. Bypass list: Add bypass > Repository admin (Always
   allow). Rules: Restrict creations, Restrict updates, Restrict deletions, and
   Block force pushes. Only admins can then create, move or delete a release
   tag, so a tag cannot be moved under a release.
2. **The `release` environment.** Settings > Environments > New environment,
   named `release`. Required reviewers: the maintainers who approve releases
   (with Prevent self-review if there is more than one). Deployment branches and
   tags: Selected branches and tags > Add deployment branch or tag rule > Ref
   type Tag, pattern `v*`. The image push, the signing and the GitHub release
   then run only for a `v*` tag, and only once a reviewer approves.
3. **Workflow permissions.** Settings > Actions > General > Workflow
   permissions: Read repository contents and packages permissions (each job asks
   for what more it needs), and leave "Allow GitHub Actions to create and approve
   pull requests" off.
4. **The package.** After the first push from `main`, on the package's page
   (Packages > yondrive > Package settings): Change visibility to Public, and
   under Manage Actions access check that this repository has the Write role.
   The image's `org.opencontainers.image.source` label links the package to the
   repository, so the README and description show there.
