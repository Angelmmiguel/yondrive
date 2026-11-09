# YonDrive plan

Status: **1.0 is released (phases 0 to 8); phase 9 (file requests) is next, then phase 10 (comments).**

This document covers what we build, the decisions that shape it, and the order
of work. The [README](README.md) is the product description.

Inputs:

- The brief: multi-user, zero knowledge, office documents, sheets, sharing, a
  Go binary with an embedded SvelteKit (Svelte 5) app, Unraid-friendly container,
  easy management, OpenAPI, Nix environment.
- The design canvas: seven interactive boards (Home, Document editor, Sheets,
  Notes list, Note editor, Media, First-run setup).

## 1. Decisions

All made in review. No questions remain open.

| # | Topic | Decision |
| --- | --- | --- |
| D1 | Encryption mode | Two modes, **End-to-end** (default) and **No encryption**. Same files, same logic, same features. The only difference is whether content is encrypted. See [section 5.3](#53-encryption-modes). |
| D2 | Passphrases | One passphrase for local accounts. SSO users have a separate unlock passphrase. |
| D3 | Heavy assets | None in v1, so everything, including pdf.js, is embedded in one binary. If a heavy component is added later, it may live as static files beside the binary, and the container must include it. |
| D4 | Co-editing | **Not supported.** Warn when someone else is editing the file. |
| D5 | HTTP | The container speaks plain HTTP. HTTPS normally comes from a proxy such as Nginx Proxy Manager or Traefik. Direct HTTP use is allowed, with a warning. |
| D6 | Media app | **Skipped for now**, along with its timeline, albums, HEIC support and photo ML. Drive still previews images and video that the browser can display. |
| D7 | Screens with no board | Derived from the components of the existing boards. |
| D8 | Order | Security → Drive → Sharing → Search and admin → Docs → Sheets → Notes. |
| D9 | Office engines | **Our own, small engines.** Fewer features, built from scratch and easy to embed. Minimal formula engine. |
| D10 | Scope of the mode | The encryption mode applies to the **whole server** and is fixed at setup. Per-user modes would complicate sharing. |
| D11 | Storage without encryption | The same shape as encrypted storage: each stored file holds the original bytes under an opaque id. The data directory is **not a browsable folder tree**. |
| D12 | Passwords without encryption | An admin can reset them, and there is no recovery key, since no key depends on them. |
| D13 | Formula engine language | **TypeScript in a worker.** See [section 6.3](#63-formula-engine). |
| D14 | Third-party code | Our own code for ZIP, XML, office formats and formulas. Small exceptions: **ProseMirror**, **pdf.js** and the crypto libraries. Their licences are checked in [section 5.10](#510-third-party-licences). |
| D15 | Formats left out of v1 | **`.pages` and `.numbers`.** They can be stored, shared and downloaded like any file, but not opened in the editors. |
| D16 | License | AGPL-3.0. |
| D17 | After 1.0 | **File requests** (phase 9), then **comments** (phase 10), released together as 1.1. Emergency access is a later feature. |

Smaller assumptions, which I will follow unless you object:

- Recovery codes are one 256-bit recovery key shown as 24 BIP39 words, and not the design's `XXXX-XXXX…` format.
- Interface in English first, with i18n in place from day one. The design's other
  languages (Spanish, Portuguese, German, French) follow later.
- Metadata is stored in SQLite through a pure Go driver. See [section 5.1](#51-server).
- The image is `ghcr.io/angelmmiguel/yondrive` and the module is
  `github.com/Angelmmiguel/yondrive`.

## 2. Principles

1. **The server never processes content, in either mode.** It handles identity,
   access control, quotas and storage. All parsing, indexing, editing and
   thumbnailing runs on the device. This is what keeps the two modes identical.
2. **In end-to-end mode, zero knowledge is the invariant.** No feature ships if it
   needs the server to read content, names, tags or search terms. An automated test
   enforces this.
3. **One container, one data directory.** No external services and nothing downloaded
   at runtime. A backup is a snapshot of a directory.
4. **No external services for content, ever.** Anything that touches user data runs
   inside the platform, from code served by the user's own YonDrive. A CSP of
   `connect-src 'self'` enforces this.
5. **Fewer features, built simply.** Prefer a small editor we fully understand over a
   complete office suite. Leave what we do not understand untouched rather than damage it.
6. **Honest about limits.** We document metadata leakage, the trust placed in served
   JavaScript and format limits, in the product as well as the docs.
7. **API first.** The web app uses the same public API as a future mobile app.

## 3. Changes to the design

The boards were mocked up before these decisions. Each row below is a required change.

| Board | Design says | Problem | Plan |
| --- | --- | --- | --- |
| All | An earlier project name in text, identifiers, paths and the recovery key prefix | Outdated | Use YonDrive everywhere. |
| All | Fonts from a third-party CDN | A third-party request on each load, and blocked by a strict CSP | Self-host Geist, Geist Mono and Source Serif 4 through `@fontsource`. |
| All | Slightly different token values per board (`--surface-2`, `--hover`, `--accent-ring`, `--bg`) | Drift between boards | One `tokens.css` with primitives and a semantic layer. App accents stay: Drive blue, Sheets green, Notes amber. |
| Setup | "No encryption": "Faster, with server-side search and previews", "so the server can index, preview and thumbnail" | The server does neither in this design (D1) | Keep the option and rewrite the copy: same features, all still on the device, files readable by anyone with server or disk access. |
| Setup | Public URL must start with `https://` | Blocks valid plain HTTP setups (D5) | Accept `http://` too, with a warning. |
| Setup | "Email me recovery codes" | Emailing recovery material gives it to the mail server and undermines zero knowledge | Remove. YonDrive never sends recovery material anywhere. |
| Setup | Separate Password and passphrase | D2 | One passphrase on the admin step for local accounts. |
| Setup | Recovery key confirmed with one checkbox | Too easy to click through, and the failure is unrecoverable | Copy, download, then type back a few requested words. |
| Setup | Data directory editable in the browser, with a free-space check | Lets a web form point the server at arbitrary paths | Show it read-only. It is set through the environment. |
| Setup | Wizard opens to whoever reaches it first | Not safe for a multi-user container on a network | One-time setup token printed to the logs, required by every wizard call. |
| Setup | "Test connection" for OIDC | The server fetches an admin-supplied URL | Keep it, restricted to the setup token or an admin session. |
| Setup | Match SSO users by email | Takeover risk if the provider does not verify addresses | Link only when `email_verified` is true. |
| Home | "New doc: Write together" | No co-editing (D4) | Change the hint to "Write and format". |
| Home | "Server healthy · backed up 3:00 AM" | Implies a built-in backup system | Show health and the last `yondrive backup` time, if any. |
| Home | Storage bar by category (photos, videos…) | The server does not know file types | Compute it on the client from the index, and fall back to the total. |
| Editor | Pages with "Page 1 of 2" | True pagination is a large layout engine (D9) | One continuous sheet of paper. Remove the page count; keep word count. Print paginates through the browser. |
| Editor | Download `.pdf` | No engine to generate it | Opens the browser's print dialog, which saves as PDF. |
| Editor | Status "No spelling issues" | Implies a spell checker | Use the browser's built-in spell check and drop the status text. |
| Editor | Notice about `.docx` | Must reflect what is true for the file | Generated per file, listing what was found and kept. |
| Sheets | "Insert chart" button, "charts and pivot tables are shown read-only" | No chart renderer (D9) | Remove the button. Existing charts and pivots are kept in the file but not drawn; the notice says so. |
| Sheets | `.pdf` download | No engine to generate it | Print dialog, as above. |
| Notes | "Saved as Markdown files", `notes/Work/….md` | Stored as opaque blobs in both modes (D11) | Reword to "Markdown, encrypted" or "Markdown". Bulk export produces real `.md` files. |
| Notes | "Encrypt this note", "Encrypted — unlock to read" | Everything is already encrypted, so the wording misleads | Remove from v1. A future option is an **extra lock** with its own passphrase. |
| Notes | Reminders | In end-to-end mode the server cannot read a reminder time | Reminders fire only while the app is open, in both modes. |
| Notes | Voice notes | No design for the recording flow | Later. |
| Media | The whole board | D6 | Not built. Kept in the canvas as a reference for later. |
| Home, Notes | Media in the app rail, "Sintra, July" tile in "Jump back in" | D6 | The rail has Drive and Notes only. "Jump back in" lists any recent file. |

Added, because the design lacks them: a warning banner when someone else is editing; a
quiet permanent "Not encrypted" indicator in that mode; a warning banner on insecure
connections.

## 4. Scope

**v1:** the features in the README: Drive, Docs, Sheets, Notes, sharing, both
encryption modes, multi-user, TOTP, OIDC, admin, OpenAPI, container and Unraid template.

**Designed for, but not built in v1:**

- iOS and Android apps (the API and crypto spec are ready for them)
- Desktop sync client (the change journal is ready for it)
- Passkey unlock through PRF (shown as an option in the design)

**After 1.0:** file requests (phase 9) and comments on documents, sheets and notes (phase 10).

**Not planned:**

- Real-time co-editing
- A full office engine
- Server-side search, thumbnails, transcoding, WebDAV or SMB, in either mode
- Admin reset of passwords or keys in end-to-end mode
- Emailed recovery material
- Deduplication across users, because it would reveal that two users hold the same file
- Word-style page layout, charts, pivot tables, tracked change editing, macros

**Later:** presentations, `.pages` and `.numbers` import, moving a server between encryption modes through
export and import, the Media app (timeline, albums, HEIC, places), extra note lock, voice notes, post-quantum
hybrid key exchange (the format has a version field for this), and **emergency access**.

**Emergency access** answers the case where a user of end-to-end mode loses both their passphrase and their
recovery key. They name a trusted user on the same server and a waiting period. Their master key, or a key that
opens their root, is sealed to the contact's X25519 key in advance, as grants are. The contact can ask for access.
If the owner does not refuse within the waiting period, the server releases the sealed key: either read access to
everything or the right to set a new passphrase, as the owner chose. The server enforces only the timing and
cannot open anything itself. It is as strong as the server is honest about the waiting period and about notifying
the owner, which must be said in the product. Open questions: whether a contact must be pinned before naming them,
what changes on key rotation, and how the owner is told about a request while no tab is open.

## 5. Architecture

```
┌───────────────────────────────────┐        ┌───────────────────────────────┐
│ Browser (SvelteKit SPA)           │  HTTP  │ yondrive (single Go binary)   │
│                                   │ ─────► │                               │
│ • Keys, encryption, decryption    │        │ • Serves the embedded SPA     │
│ • Parsing, editing, conversion    │        │ • Identity, sessions, OIDC    │
│ • Thumbnails and previews         │        │ • Access control, quotas      │
│ • Search index                    │        │ • Node tree of opaque ids     │
│ • IndexedDB cache                 │        │ • Change journal, edit status │
│ • Web Workers, service worker     │        │ • SQLite + stored files       │
└───────────────────────────────────┘        └───────────────────────────────┘
        ▲ HTTPS through a reverse proxy, or plain HTTP with a warning
```

### 5.1 Server

**Language and dependencies.** Go 1.26, `net/http`, `log/slog`, `crypto/*`. Dependencies
stay few and deliberate. The expected list is a pure Go SQLite driver (`modernc.org/sqlite`)
and the runtime that generated OpenAPI code needs. TOTP and OIDC verification are done with the
standard library.

**Why SQLite.** YonDrive needs users, invitations, a mutable tree, grants, versions, quotas, a journal
and transactions spanning them. Hand-rolling that on files would be riskier than a dependency. The
pure Go driver keeps `CGO_ENABLED=0` and a `scratch` image. There is no support for an external
database, so there is nothing to configure.

**Layout on disk**

```
/yondrive                   Go binary, with the SPA, office code and pdf.js embedded
/data/
  yondrive.db               SQLite (WAL): accounts, tree, grants, journal
  blobs/ab/<id>             one stored file per version, thumbnail or index
  uploads/<id>              in-progress uploads
  lock                      advisory lock against a second process
```

Each file version is one file on disk with fixed-size frames, not one disk file per chunk. This
keeps range reads trivial, and avoids millions of small files, which are slow on NAS filesystems
such as Unraid's array.

**Data model (server view)**

| Table | Holds | Server can read in end-to-end mode |
| --- | --- | --- |
| `users` | Username, email, role, quota, KDF parameters, auth hashes, public keys, TOTP secret | Yes, apart from the sealed blobs: wrapped master key and sealed private keys |
| `nodes` | Id, owner, parent, file or folder, suite, trashed, purged and removal times, sealed metadata, wrapped node key, name tag, current version | Structure only |
| `versions` | Node, blob, author, sealed-as id and signer, stored size, frame count and size, frame hashes, author signature, manifest as sent | Sizes and timing |
| `blobs` | Id, owner, node if any, kind (content, thumbnail, index), suite, size, ref count | Sizes |
| `uploads`, `upload_frames` | Uploads in progress: target, reservation, the digest of each frame that arrived | Sizes and timing |
| `grants` | Node, grantee, role, node key sealed to the grantee | The share graph |
| `links` | Id, node, role, expiry, revoked time, password KDF parameters, sealed key | Settings only |
| `changes` | Sequence, owner, node, operation | Timing and which node changed |
| `file_removals` | Files whose rows are gone, waiting to be unlinked | Ids |
| `edit_status` | Node, user, device, last heartbeat | Who is editing what |
| `sessions`, `tokens`, `password_resets`, `recovery_codes` | Hashes, expiry | Yes |
| `invites`, `settings`, `audit` | Admin data, including the fixed encryption mode | Yes |

The OIDC client secret must be stored readable by the server. It protects sign-in only and cannot
decrypt any data.

### 5.2 Cryptography (end-to-end mode)

[`docs/CRYPTO.md`](docs/CRYPTO.md) is the normative, language-independent spec, with test vectors that
any future client must pass.

```
passphrase (NFKC)
  └─ Argon2id(salt, m=64 MiB, t=3, p=1) ─► root
       ├─ HKDF "yondrive/kek/v1"   ─► KEK       never leaves the device
       └─ HKDF "yondrive/auth/v1"  ─► auth key  sent to server: signs in a local account;
                                                 for SSO, only proves a current credential

recovery key (32 random bytes, shown once as 24 BIP39 words)
  ├─ HKDF "yondrive/kek/v1"   ─► recovery KEK
  └─ HKDF "yondrive/auth/v1"  ─► recovery auth key

master key (32 random bytes, per user)
  ├─ wrapped under KEK, recovery KEK, and the session key
  ├─ seals the user's X25519 and Ed25519 private keys
  └─ wraps the user's root node key

node key (32 random bytes, per file or folder)
  ├─ wrapped under the parent's node-wrap subkey; sealed to a user's X25519 key for a grant
  ├─ HKDF "yondrive/node-wrap/v1" ─► wraps the node keys of its children
  ├─ HKDF "yondrive/meta/v1"      ─► seals name, type, dates, tags
  ├─ HKDF "yondrive/name/v1"      ─► name HMAC (duplicate detection in a folder)
  └─ HKDF "yondrive/content/v1"   ─► per-version content key
```

- **Local accounts** derive both the KEK and the auth key from one passphrase. HKDF is one-way, so
  the server that receives the auth key learns nothing about the KEK. **SSO accounts** use the same
  derivation from a separate unlock passphrase. They send the auth key only to prove a current
  credential, never to sign in, and its hash is in a column sign-in does not read. See
  [`docs/CRYPTO.md`](docs/CRYPTO.md), section 3.
- **Content** is framed in 4 MiB chunks of XChaCha20-Poly1305, with the node, version, frame index
  and a final-frame flag bound in the AAD. The server cannot reorder, swap or truncate frames without
  detection.
- **Names** are sealed. The HMAC lets the server reject duplicate names in a folder without learning
  them.
- **Sorting and listing** happen on the client in both modes. Very large folders are paged by id and
  sorted after decryption.
- **Versions are signed** with the author's Ed25519 key. Read access technically includes the ability to
  encrypt, so the viewer and editor roles are enforced by the server, and clients verify the signature
  against an author who holds edit rights.

**Guarantees**

- Split session key for surviving a reload; usable keys only in memory, zeroed on lock; lock is broadcast
  across tabs.
- A session alone cannot replace wrapped keys: rekeying requires a current credential, and is atomic with
  the wrapped keys.
- Strict CSP, generated at build time and delivered by the Go handler.
- `@noble/*` and `@scure/*` at exact versions, `--frozen-lockfile`, install scripts disabled, minimum
  release age. These are pure JS and do not need `crypto.subtle`, so encryption also works over plain HTTP.

**New problems that multi-user creates**

| Problem | Plan |
| --- | --- |
| **The server could hand out a false public key** when you share, and read everything shared afterwards. | Pin each contact's keys on first use and warn if they change. Show a safety number that two people can compare. |
| **Username probing** through the KDF endpoint. | Unknown usernames get stable fake parameters derived from a server secret. |
| **SSO compromise** gives access to a user's wrapped key, which can be attacked offline. | Enforce a minimum passphrase strength. Argon2id sets the price of each guess. |
| **Removing someone from a shared folder.** They may have kept the keys. | Rotate the node key on revoke for future content. Say plainly that earlier content may have been copied. |
| **A stolen session can delete files.** | Trash, version history and a server-enforced grace period before anything is purged. |
| **Malicious documents from other users** run in the same origin as the keys. | Our parsers run in workers and output a typed model, never HTML. Build the page from that model rather than sanitising HTML, keep CSP strict, and download SVG and HTML instead of rendering them inline. |

### 5.3 Encryption modes

Both modes run the same server code, API, schema and client pipelines. The client has one `Sealer`
interface, which is the only place the modes differ.

| | End-to-end | No encryption |
| --- | --- | --- |
| Suite recorded on every item | `xchacha20poly1305-v1` | `none` |
| Content frames | Encrypted, with an auth tag | Original bytes. The blob is byte-identical to the file |
| Integrity | Auth tag per frame | SHA-256 per frame, to detect disk corruption |
| Metadata column | Sealed | The same fields as readable JSON |
| Keys, grants | Master key, node keys, sealed to recipients | None. Grants are just rows |
| Local sign-in | Auth key derived on the client | The same |
| SSO | Unlock passphrase | No unlock step |
| Recovery key, key pinning, signatures | Yes | Not used |
| Forgotten password | Recovery key only | Admin issues a reset link |
| Public link | Key in the URL fragment, or wrapped under a password the server checks | No key. Password checked by the server |
| Search, thumbnails, conversions | On the device | On the device |

**Downgrade protection.** A hostile server could claim to be in `none` mode so that clients upload plaintext.

- The mode is written once at setup, and the server has no route to change it.
- In end-to-end mode, each account has wrapped keys. A client that finds keys for the account refuses `none`,
  and each device pins the mode it first saw, stopping with an alert if it changes.
- Native clients get the same check, where it is stronger since they do not load their code from the server.
  In the web app, this catches mistakes and migrations but not a server that also replaces the JavaScript,
  which is the limit documented in the README.
- The app shows a quiet, permanent "Not encrypted" indicator in `none` mode.

**Testing.** The whole e2e suite runs in both modes. This is the check that the modes really behave the same.

### 5.4 Sharing

- **User to user.** In end-to-end mode the node key is sealed to the recipient's X25519 key and signed by the
  owner, who alone shares. Sharing a folder covers its whole subtree, because children are wrapped under it.
- **Revocation.** Access ends with the commit. The client then rotates each node key from the top of the share
  down. Versions record the generation of the key they are sealed under, and each new key opens the one before.
- **Public link.** The client creates a link key and the URL carries it in the fragment:
  `https://host/s/<id>#<key>`. Browsers do not send fragments to servers.
- **Link password.** Argon2id on the client gives an auth key, which the server checks against a stored hash and
  rate-limits, as at sign-in. In end-to-end mode it also gives a key that wraps the link key, and the server hands
  the wrapped key only to the right password.
- **Expiry, download limits and revocation** are enforced by the server, and are therefore as strong as the server
  is honest.
- **File request (phase 9).** An upload-only link to a folder. Anonymous uploaders encrypt to a key that only the
  owner can open, and cannot list or read anything, including what they uploaded.
- **Commenter role (phase 10).** Between viewer and editor: can read and comment, not edit.

### 5.5 Client-side features

| Feature | Approach |
| --- | --- |
| Search | An inverted index, stored as per-user segments with compaction, cached in IndexedDB and searched in memory. Text is extracted on save. Recipients index what is shared with them. |
| Thumbnails | Generated by the uploader in a worker and stored like any other blob. Formats the browser cannot decode, such as HEIC in most browsers, get a generic icon and can be downloaded. Video uses a `<video>` frame capture, so it depends on browser codecs. |
| Large downloads and video | Service worker decrypts frames as a stream, with range requests mapped to frames. Spike B validates this. Without a secure context, service workers are unavailable, so content is decrypted into a Blob up to a size limit. |
| PDF | `pdf.js` in a worker, lazily loaded. |
| Notes | Files of type Markdown in a hidden root, so they get versioning, sharing and quota at no extra cost. An index holds backlinks and tags, built and kept on the device. |

**Insecure contexts (D5).** The banner depends on `window.isSecureContext`, so it never shows behind an HTTPS proxy.
Over plain HTTP we also provide alternatives to the Clipboard API (the recovery key can be downloaded), and to
service worker streaming.

### 5.6 API

- OpenAPI 3.1, written by hand at `api/openapi.yaml` and served at `/api/openapi.yaml`.
- Generated code: `oapi-codegen` for Go types and the `net/http` server interface; `openapi-typescript` for the web
  client. CI fails if generated code is out of date.
- Versioned under `/api/v1`. Errors are JSON with stable codes. `GET /api/v1/health` reports the encryption mode.
- Browsers use an HttpOnly, SameSite=Strict cookie. Native clients use named bearer tokens per device, which can be
  revoked individually.
- `Secure` on the cookie follows `YONDRIVE_SECURE`. `auto` uses the `X-Forwarded-Proto` of a trusted proxy. The admin
  area warns if requests look proxied but the proxy is not trusted, the most likely misconfiguration.
- Binary uploads are resumable: create, send frames in any order, commit.

```
/api/v1/health, /setup/*                       First-run wizard, setup token
/api/v1/auth/*                                 KDF params, login, logout, TOTP, OIDC, rekey, recover
/auth/oidc/callback                            The redirect URI to give a provider
/api/v1/session/key                            Server half of the split session key
/api/v1/me, /me/tokens, /users/{id}/keys       Profile, device tokens, public keys
/api/v1/nodes, /nodes/{id}, /nodes/{id}/...    Tree, move, trash, versions
/api/v1/nodes/{id}/editing                     Heartbeat and who else is editing
/api/v1/uploads, /uploads/{id}/frames/{n}      Resumable upload
/api/v1/blobs/{id}                             Stored file, with Range
/api/v1/changes?cursor=                        Change journal for sync
/api/v1/grants, /links                         Sharing
/api/v1/public/links/{id}                      Anonymous access to a public link
/api/v1/admin/*                                Users, invites, quotas, settings, health
```

### 5.7 Frontend

Conventions: Svelte 5 runes only, no `svelte/store`, shared state in `.svelte.ts` files, an API client
that knows nothing about crypto, routes as thin glue, components that own their interactions.

The first step is a shared component library extracted from the boards: app rail, sidebar and nav, buttons, segmented
control, field, select, switch, stepper, file row and tile, tag, toolbar, side panel with tabs, dropdown menu, notice,
progress bar and dialog. Screens with no board are composed from these (D7), and shown to you for review.

| Route | Source |
| --- | --- |
| `/setup` | Setup board, with the changes in section 3 |
| `/`, `/files/[id]`, `/shared`, `/shared/by-me`, `/recent`, `/favorites`, `/trash`, `/tags/[id]` | Home board |
| `/doc/[id]` | Document editor board |
| `/sheet/[id]` | Sheets board |
| `/notes`, `/notes/[id]` | Notes list and Note editor boards |
| `/signin`, `/unlock`, `/recover`, `/s/[id]`, `/settings`, `/admin`, share dialog, upload queue, viewers | Derived from the components |

Every screen needs a phone layout, which the boards do not show. The canvas marks them as fluid pages, so the rail and
sidebars collapse below a breakpoint.

### 5.8 Repository layout

```
flake.nix  flake.lock  .envrc  justfile  Dockerfile  CLAUDE.md
api/openapi.yaml
cmd/yondrive/            serve, backup, restore, migrate, admin, version, assets
internal/
  api/                   generated types and server interface
  auth/  oidc/           sessions, rate limits, TOTP, OIDC
  server/                handlers and middleware
  store/                 SQLite and migrations
  blobs/                 stored files
docs/                    ARCHITECTURE, CRYPTO + vectors, SECURITY, API, OPERATIONS, RELEASE, PROXY, OIDC
unraid/yondrive.xml
web/
  embed.go               embeds the built app
  src/lib/crypto/        primitives, keys and the Sealer
  src/lib/formats/       zip, xml, ooxml, odf, rtf, cfb, markdown
  src/lib/formula/       parser, dependency graph, functions
  src/lib/{api,account,drive,sharing,search,docs,sheets,notes,state,components,styles}
  src/routes/
  tests/{e2e,fixtures}
```

### 5.9 Outbound connections

The server makes outbound connections only for OIDC and, if configured, SMTP for invitation emails, so the image carries a CA bundle. `YONDRIVE_CA_FILE` adds an authority for an internal issuer.
Invitation links can always be copied by hand, so SMTP stays optional.

### 5.10 Third-party licences

All are compatible with distribution under AGPL-3.0. CI will fail on any new dependency whose licence is not on an allow list.

| Component | Used for | Licence |
| --- | --- | --- |
| ProseMirror: `prosemirror-model`, `-state`, `-view`, `-transform`, `-commands`, `-history`, `-keymap`, `-tables`, `-gapcursor` | Document and note editing | MIT |
| `orderedmap`, `rope-sequence`, `w3c-keyname` | Linked through ProseMirror | MIT |
| pdf.js (`pdfjs-dist`) | PDF viewing | Apache-2.0 |
| `@noble/*`, `@scure/*` | Cryptography | MIT |
| `modernc.org/sqlite` | Metadata | BSD-3-Clause; carries SQLite (public domain) |
| `modernc.org/libc`, `mathutil`, `memory`, `golang.org/x/sys`, `remyoudompheng/bigfft`, `google/uuid` | Linked through the SQLite driver and the API runtime | BSD-3-Clause |
| `dustin/go-humanize`; musl and `go-netdb` inside `modernc.org/libc` | Linked through the SQLite driver | MIT |
| `oapi-codegen/runtime` | Runtime of the generated server code | Apache-2.0 |
| `apapsch/go-jsonmerge` | Linked through `oapi-codegen/runtime` | MIT |
| Geist, Geist Mono, Source Serif 4 | Fonts | OFL-1.1 |
| `oapi-codegen`, `openapi-typescript` | Code generation at build time | Apache-2.0, MIT |
| `@axe-core/playwright`, `axe-core` | Accessibility checks in the browser tests; development only, never shipped | MPL-2.0 |

## 6. Documents and spreadsheets

Everything here is our own code, running in workers, with no large dependencies (D9). The target is what the
design's toolbars show, with nothing beyond it.

### 6.1 Shared format layer

Small pieces, each independently testable with no framework:

- **ZIP:** our own reader and writer on the browser's native `DecompressionStream` and `CompressionStream`.
- **XML:** a small pull parser of our own, because `DOMParser` is not available in workers.
- **CFB:** the container used by `.doc` and `.xls`.

### 6.2 Keeping files intact

**Unedited content is written back verbatim.** Each block in the editor keeps a reference to its original XML. On save, only
changed blocks are regenerated, and every other byte comes from the original package. This one rule delivers most of the
design's promise at a fraction of the complexity.

- Content we cannot represent, such as a paragraph with tracked changes, a text box or an equation, appears as a locked,
  labelled block. It is displayed as well as we can, and not editable.
- Parts we do not read, such as macros, charts, pivots, headers and comments, stay in the package untouched.
- The notice at the top of the editor lists exactly what this file contains and how it is handled.
- Saving to a different format (`.docx` to `.odt`) passes through the editor model and loses locked content. The UI warns
  first and the original stays in Versions.

### 6.3 Formula engine

**TypeScript in a worker (D13).** It is tens of KB, is embedded with the rest of the client, and shares its tests and build. Numbers are IEEE 754 doubles, the same as Excel.

Scope, kept deliberately minimal:

- **Syntax:** numbers, strings, booleans, arithmetic, comparison, `&`, percent, parentheses, relative and absolute references,
  ranges, references to other sheets. Excel error values.
- **Recalculation:** a dependency graph with incremental updates and cycle detection.
- **About 40 functions:**
  - Math: `SUM AVERAGE MIN MAX COUNT COUNTA ROUND ROUNDUP ROUNDDOWN ABS INT MOD POWER SQRT`
  - Logic: `IF IFERROR AND OR NOT`
  - Conditional: `SUMIF COUNTIF AVERAGEIF`
  - Lookup: `VLOOKUP HLOOKUP INDEX MATCH`
  - Text: `LEFT RIGHT MID LEN TRIM UPPER LOWER CONCAT TEXT VALUE FIND SUBSTITUTE`
  - Date: `TODAY NOW DATE YEAR MONTH DAY`
- **Unknown functions:** the formula text and last cached value from the file are kept and the cell becomes read-only. Cells that
  depend on it use that cached value, and the notice says so. We never overwrite a formula we cannot calculate.
- **Not in scope:** array formulas, named ranges at first, external references, volatile layout functions.

### 6.4 Documents

- **Editor:** ProseMirror directly (D14), with the design's toolbar, outline, details and versions panels.
- **Features:** headings, quote, code, bold, italic, underline, strike, font, size, text color, highlight, bulleted, numbered and
  check lists, alignment, links, images, tables, find and replace.
- **`.docx`, `.odt`:** mapped to and from the editor model using the rules above.
- **`.rtf`, `.md`, `.txt`:** direct converters.
- **`.doc`:** the CFB container and Word's piece table give text with basic formatting. Best effort, saved as `.docx`.

### 6.5 Spreadsheets

- **Grid:** our own virtualised grid in Svelte, matching the design: formula bar, name box, sheet tabs, status sum.
- **Features:** number formats, font size, bold, italic, strike, text and fill color, borders, merge, alignment, wrap, sort, filter, and
  add or remove rows, columns and sheets.
- **`.xlsx`, `.ods`:** the cell-level version of writing back verbatim. Untouched cells and styles stay as they were.
- **`.csv`, `.tsv`:** direct. Saving the current sheet only, as in the design.
- **`.xls`:** BIFF8 in CFB gives values, formulas and basic formatting. Best effort, saved as `.xlsx`.
- **Known gap:** inserting a row or column updates formulas, but kept charts and pivots still refer to their old ranges. The UI warns before
  doing this in a file that has them.

### 6.6 Someone else is editing (D4)

- Opening the editor sends a heartbeat to `/nodes/{id}/editing`, and stops on close or after a short timeout.
- If someone else is active, a banner shows who, and you can continue anyway. It is a warning, not a lock.
- Saves carry the version they started from. If the file has moved on, the save becomes a separate copy with a clear name, so nobody
  silently overwrites anyone. Merging is out of scope.

## 7. Nix environment

One locked `nixos-unstable`, since Go 1.26 needs a current channel. All of the tools below are available in nixpkgs, and `flake.lock` pins their versions.

```nix
packages = with pkgs; [
  # Go server
  go gopls gotools golangci-lint delve
  oapi-codegen          # Go code from the OpenAPI spec
  sqlite                # inspecting yondrive.db

  # SvelteKit frontend
  nodejs_22 pnpm
  # @playwright/test in web/package.json must match this exact version.
  playwright-driver.browsers
  redocly               # OpenAPI lint

  just
];

shellHook = ''
  export GOPATH="$PWD/.go"
  export GOMODCACHE="$GOPATH/pkg/mod"
  export GOCACHE="$GOPATH/cache"
  export PATH="$GOPATH/bin:$PATH"
  export PLAYWRIGHT_BROWSERS_PATH="${pkgs.playwright-driver.browsers}"
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true

  for f in .env .env.local; do
    if [ -f "$f" ]; then set -a; . "$f"; set +a; fi
  done
'';
```

`.gitignore` gains `.go/`, `.direnv/`, `bin/`, `dist/`, `data/`, `docs/api/`, `.env.local` and `web/build/*`. CI runs each job inside `nix develop`, so it uses the
same pinned toolchain. A second shell, `nix develop .#release`, adds cosign and syft for the release workflow.

## 8. Delivery phases

Each phase ends with its exit criteria met and with `just test`, `just lint`, and `just web-e2e` clean. Sizes are relative: S, M, L, XL.

### Phase 0: Foundations and spikes

**Scaffolding (S).** Flake, justfile, CI, `CLAUDE.md`, Go server serving an embedded SvelteKit shell, OpenAPI pipeline with a
health route, `tokens.css`, self-hosted fonts, Dockerfile.

**Spikes.** Throwaway code, ending in written findings that update this plan.

| Spike | Question | Pass criteria |
| --- | --- | --- |
| **A: Keeping files intact** | Does writing back verbatim hold up on real `.docx` and `.xlsx` files? How much of a typical file does the editor subset cover? | On a test set of real files, opening, editing one paragraph or cell and saving leaves everything else byte-identical, and the result opens without complaint in Word and Excel. We measure what share of typical content is editable and not locked. |
| **B: Streaming** | Do framed encryption, a service worker and range requests play and download large files? | A 4 GB video seeks in Chrome, Firefox and Safari. Throughput and memory on a mid-range phone are measured. |
| **C: Scale** | Do client-side listing and search hold up? | 100,000 nodes: unlock to usable, search latency and IndexedDB size are measured and acceptable. |

**Exit:** `nix develop && just build` gives a working binary. The format table in the README is corrected to match the findings.

**Findings** are in `docs/spikes/`. The mechanisms hold, and these checks stay open because they could not be run in the development environment:

- Opening saved files in Word and Excel, with a corpus of real files (moved to the Phase 5 and 6 exit criteria).
- Safari, a real 4 GB video, and phone throughput and memory (moved to Phase 8).

They also add three requirements: the service worker caps open-ended ranges and can get the content key again after a browser restart; listing decrypts lazily in a worker and pages by id; and a spreadsheet edit also rewrites dependent cached values and `calcChain.xml`, and appends shared strings rather than changing them.

### Phase 1: Security core (L)

- `docs/CRYPTO.md` and test vectors, `docs/SECURITY.md`
- Schema, migrations and setup token; the `Sealer` and both encryption modes from the start
- Component library from the boards
- Setup wizard, sign-in, unlock, lock, recovery, passphrase and recovery key change
- Invitations and multiple local users, TOTP
- **Zero knowledge canary test:** an e2e test uploads files with unique strings in names and contents, then scans the database, blobs, logs and
  captured request bodies to confirm they never appear. It runs in CI for the rest of the project.

**Exit:** two users can register on one server. In end-to-end mode, neither the server nor an admin can obtain their keys, and a lost passphrase can be
recovered with the recovery key and nothing else. A test confirms the downgrade protection. In no-encryption mode, the same flows work without keys.

### Phase 2: Drive core (L)

- Node tree, metadata, resumable uploads, downloads
- Home board: rail, sidebar, list and grid, breadcrumbs, favorites, tags, recent
- Trash and purge, versions and restore, quotas, change journal
- Viewers for image, PDF, text, audio, video; client thumbnails
- `yondrive backup`; first container image

**Exit:** usable as a private drive in both modes. **Release 0.1.**

### Phase 3: Sharing (M)

- Grants with viewer and editor roles; Shared with me
- Key pinning, safety numbers, revocation with rotation
- Public links with password, expiry and limits; public viewer page
- Share dialog and "shared by me" page

**Exit:** a shared folder and a password-protected public link work end to end, and the canary test covers both. An e2e test confirms that a swapped public key
triggers the warning. **Release 0.2.**

### Phase 4: Search and administration (M)

- Encrypted search index, ⌘K search, filters
- OIDC with provider guides (Pocket ID, Authelia, Authentik, Keycloak)
- Admin: users, quotas, sign-in settings, health
- Unraid template; guides for Nginx Proxy Manager and Traefik

**Exit:** a fresh Unraid install behind a proxy takes under five minutes to get to the first upload, using SSO. **Release 0.3.**

### Phase 5: Documents (L)

- Format layer: ZIP, XML, CFB
- Editor with toolbar, outline, details and versions panels, view mode
- `.docx` and `.odt` round trip, `.rtf`, `.md`, `.txt`; best-effort `.doc` import
- Print and export; "someone else is editing" warning; separate copies on conflict

**Exit:** the test set round trips with unedited content byte-identical, verified automatically and by opening results in Word, on a corpus of real files. **Release 0.4.**

Built and checked automatically on synthetic files (pandoc output, and a `.doc` built to the format's layout). Still open
before this exit: the corpus of real files from Word and other office applications, and opening saved files in Word.

### Phase 6: Spreadsheets (L)

- Formula engine and its test set
- Virtualised grid, formula bar, sheet tabs, formatting, sort, filter
- `.xlsx` and `.ods` round trip, CSV and TSV; best-effort `.xls` import

**Exit:** the same round trip standard as documents. Results open in Excel, on a corpus of real files. Supported functions match Excel's results on a test set. A 100,000-cell sheet scrolls smoothly and recalculates without blocking the UI. **Release 0.5.**

Built: the engine, the formats, and the editor with the board's toolbar, formula bar, tabs, filter, sort, undo and
panels, checked automatically on files written by hand to each format's layout and in Chromium in both modes,
including a 100,000-cell sheet that draws only what is in view and calculates in the worker. Still open before this
exit: the corpus of real files, opening saved files in Excel and LibreOffice, checking the function table against
Excel itself, and scrolling measured on real phones and other browsers.

### Phase 7: Notes (M)

- Notes list and editor boards: notebooks, tags, pins, checklists
- Wiki links, backlinks, unlinked mentions, slash menu, quick capture, daily notes, templates, export

**Exit:** bulk export produces plain Markdown files with links intact. **Release 0.6.**

Built: both boards with notebooks, tags, pins, checklists with due dates, `[[` links to notes and files that
survive renames, backlinks, unlinked mentions, the slash menu, quick capture, today's note, templates, reminders
while the app is open, sharing through the share dialog, exports of a note (Markdown, PDF by printing, HTML, a
document in Drive) and of every note as a ZIP whose links are checked in the browser specs to reach the exported
files. No server change was needed: the folder of notes is marked in its sealed metadata. The notes index is kept
on each device rather than on the server, as it is quick to build from the notes. Still open: checking exports
in other Markdown editors, and reminders that come due while no tab is open, which wait for the next one.

### Phase 8: Hardening and 1.0 (M)

- Independent security review of the crypto and the sharing flows, if you can arrange one
- Accessibility pass (the boards are thorough here, so the implementation should match), performance budgets, phone layouts
- Reproducible builds, signed images, published hashes of the web assets
- Safari, a real 4 GB video, and phone throughput and memory, left open by Phase 0
- Upgrade tests across schema versions, backup and restore drills
- Operator and API docs

Built for release engineering: reproducible builds (the same commit gives the same binary and web app
from `just build` and the Dockerfile, checked by `just verify-reproducible`), release builds with the
official Go release rather than the patched one in nixpkgs, `yondrive version` and `yondrive assets`
with the web app's root hash in health and the admin area, a release workflow on `v*` tags, refused unless the tag is a release version on `main` with a dated
changelog section, with binaries, SHA256SUMS, SBOMs, and keyless signatures and provenance made
in jobs apart from the build ([docs/RELEASE.md](docs/RELEASE.md)),
[CHANGELOG.md](CHANGELOG.md), upgrade tests from every schema version, `yondrive migrate` and
`yondrive restore` with a backup and restore drill in Go and in the browser, operator commands to get
back in, [docs/OPERATIONS.md](docs/OPERATIONS.md) and [docs/API.md](docs/API.md). Open: the first
tagged release, which is the only way to exercise the signing, provenance and publishing steps.

Built for accessibility and performance: every screen checked with axe's WCAG 2.1 AA rules in both themes, from
the keyboard, and at 390 and 360 wide (a skip link, a 3:1 focus ring and field edges, reduced motion, 44px touch
targets on phones); size budgets that fail the build, with the office formats out of the shell; page timings for
1,000 files, a document, a 100,000-cell sheet and 500 notes; and a WebKit project running a smoke subset, now that
WebKit starts here with Mesa's EGL driver ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). Open: Safari itself,
a real 4 GB video, and throughput and memory on a phone, which need real devices.

**Exit: Release 1.0.**

### Phase 9: File requests (M)

An owner shares a link that lets anyone drop files into one of their folders without seeing what is there: an
accountant sending documents, a client delivering assets, family sending photos.

**Keys.** The uploader cannot wrap a node key under the folder's key, since that would let them read the folder.
Instead:

- Creating a request makes a fresh X25519 key pair for it. The public key goes in the URL fragment:
  `https://host/r/<id>#<public key>`. The private key is sealed under the owner's master key and stored with the link.
  The link itself vouches for the key, so a server that swaps keys is caught, as with any link.
- For each file, the uploader's browser makes a node key, seals content and metadata under it as usual, and seals the
  node key to the request's public key. Nothing the uploader holds can open anything else.
- Uploads wait outside the tree as **incoming items** until the owner's client adopts them. Adopting one opens its
  node key with the request's private key, wraps it under the folder, computes the name HMAC, and signs the manifest
  as the owner. Content frames are not re-encrypted. Adoption runs when the owner opens the app, and shows a count.
- Uploaded files are untrusted, as anything from another user is. Metadata records that the file arrived through a
  request.
- In no-encryption mode the same flow runs without keys: uploads still wait until they are adopted, so both modes keep
  one shape.

**Server.**

- `links` gains a kind, `view` or `request`, with the request's limits: expiry, password, maximum file size, file
  count and total bytes. The link's own limits are enforced on top of the owner's quota, which the uploads count
  against.
- Anonymous upload routes under the link token reuse resumable uploads and their checks, with stricter rate limits
  per address. They return no listing and no existing ids.
- The owner lists, adopts or deletes incoming items. Items not adopted within the link's lifetime plus the grace
  period are purged.
- The server sees the number of items, their sizes and times, and the uploader's address, as with any upload. An
  optional uploader name and message are sealed with the file.

**Client.** "Request files" in the share dialog of a folder the user owns, with the limits above. A public upload
page with a drop zone, progress, resume, and a plain confirmation that keeps nothing visible afterwards. A
notification and an incoming list for the owner, with adopt and delete.

**Exit:** an anonymous visitor uploads to a password-protected request, the owner adopts the files, and the canary
test confirms that names and contents never reach the server. A tamper test confirms that a swapped request key is
refused. Uploads stop at each limit with a stable error code. Released with phase 10 in 1.1.

Built as designed, with these additions from review: the owner's copy of the request key also binds the folder, so
a server cannot redirect adoption into another folder; the sender's page refuses to send when the address carries
a key and the server claims no encryption; the server chooses the ids of uploaded files; uploads through a request
that stay idle for an hour are dropped and give their place back; and a new request offers a 1 GB total limit by
default. See [docs/CRYPTO.md](docs/CRYPTO.md) section 20 and the "File requests" section of
[docs/SECURITY.md](docs/SECURITY.md).

### Phase 10: Comments (L)

Co-editing is out (D4), so comments are how people collaborate on a shared file. Threads are anchored to a range of
text in a document or note, or to a cell in a sheet, and can be resolved.

**Records.**

- A comment is a record beside the file, never inside it, so `.docx`, `.xlsx` and other files keep their exact bytes.
  Comments already in a file stay where they are, kept as today.
- The body is sealed under a key derived from the node key (`yondrive/comment/v1`) and records the key generation,
  as versions do, so rotation on revoke covers comments. It is signed by its author, and clients verify the author
  against someone who holds at least commenter rights.
- The anchor is a separate sealed field. For text it holds the quoted text, some text around it and its block; on
  load the client finds the best match and shows unmatched comments as "text no longer found". For sheets it holds
  the sheet and cell, which editors update when rows or columns move, signing the anchor themselves.
- In no-encryption mode the same records hold readable JSON.

**Server.**

- A `comments` table: node, thread, author, times, a resolved flag, sealed body and anchor, signatures. Limits on
  body size and on comments per file.
- A new **commenter** role. Viewers read comments; commenters and editors write them. The author edits or deletes
  their own; the file's owner deletes any; editors resolve.
- Notifications per file for users with access, with ids only. Mentions are left for later, since a list of
  mentioned users would be readable by the server.
- The server learns who commented on which file, when, and how much: the same kind of metadata as versions.

**Client.** A comments panel in the document, sheet and note editors and in the viewers, with threads, replies,
resolve and reopen. Highlights in text and a corner mark on cells. Comments in search on the device. Public links
and file requests do not show comments.

**Exit:** two users comment on a shared document, sheet and note in both modes; an anchor survives edits to the text
around it and rows inserted above a cell; a comment with a forged author is refused; the canary test covers comment
bodies; saving a commented `.docx` or `.xlsx` leaves its bytes unchanged. **Release 1.1**, with file requests.

Built as designed, with these choices from building it: a thread may also be about the whole file, which is what the
viewers offer; the body and the anchor are signed over the sealed bytes with the ids and the generation, and the
anchor is believed only from the thread's author or from someone who may edit; an editor's moves of cell anchors are
signed and sent once the file is saved, and a cell whose row or column is deleted stays with the thread as lost;
a file counts the changes to its comments (`comment_seq`), which the journal reports as `commented`, so other
devices read them again and search indexes their words with the file's text. Sorting a range does not move
anchors. A thread's author may delete its first comment only while nobody else has replied; the owner may delete
any thread, and deleting a user takes the replies to the threads they started with them. Undoing the delete of a
row or column finds its threads' cells again. Bodies are limited to 16 KiB sealed, anchors to 4 KiB and a file to
2,000 comments, and placing quotes reads a document once and weighs each quote at a bounded number of places. See
[docs/CRYPTO.md](docs/CRYPTO.md) section 21 and [docs/SECURITY.md](docs/SECURITY.md).

## 9. Testing

- **Go:** `go test -race` on every route and store operation; hardening tests for limits, ids and headers.
- **Web:** vitest for logic; RFC known-answer tests for each primitive.
- **E2E:** Playwright against throwaway servers, in both encryption modes. Fixtures are synthetic.
- **Security:** the canary test; cross-language crypto vectors; tamper tests where the server swaps, reorders or truncates frames and swaps keys; downgrade tests.
- **API:** Redocly lint; contract checks of routes against the spec; drift check on generated code.
- **Office:** a corpus of real files with automated round trip comparison, and parsers fuzzed against malformed files, since they read untrusted input.
- **Formulas:** a table of cases with expected values taken from Excel.

## 10. Main risks

| Risk | Likelihood | Impact | Response |
| --- | --- | --- | --- |
| Real-world files use features outside our editor subset, leaving many locked blocks | High | High | Spike A measures it first. Extend the subset where the data says it matters. Locked blocks stay safe and readable, so the failure is limited. |
| Overall size of the project: this is effectively four products | High | High | Phases that each deliver a usable release. A smaller office scope already helps. |
| Best-effort `.doc` and `.xls` imports are visibly imperfect | High | Medium | Say so in the UI, keep the original in Versions, and offer download at any point. |
| Bugs in our own parsers and writers corrupt a file | Medium | High | Every save creates a version, so the previous file is always recoverable. Fuzzing and round trip tests in CI. |
| Formula results differ from Excel in edge cases | Medium | Medium | Test table from Excel. Unknown functions keep cached values rather than guessing. |
| Modes drift apart over time | Medium | Medium | One `Sealer`, and the whole e2e suite running in both modes. |
| A server claims no-encryption mode to obtain plaintext | Low | High | Account and device pins. Documented limit against a server that also replaces the app. |
| Users assume no-encryption mode is private | Medium | Medium | Clear choice at setup and a permanent indicator. |
| Pure JS crypto is too slow for large video on phones | Medium | Medium | Spike B measures it. Frame size and worker count can be tuned. |
| Client-side search and listing degrade with very large libraries | Medium | Medium | Spike C. Segments with compaction, lazy loading. |
| Users lose both passphrase and recovery key | Medium | High for them | Forced confirmation at setup. A reminder and a way to generate a new key in Settings. Clear language. |
| Compromised server serves a malicious app | Low | High | Cannot be eliminated on the web. Documented, with reproducible builds and published hashes to allow checking. Native clients later. |
| Plain HTTP used beyond a trusted LAN | Medium | High | Permanent warning and proxy guides. |

## 11. What happens next

1.0 is out, and phases 9 and 10 are built for 1.1.
