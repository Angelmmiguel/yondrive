# The YonDrive API

For people writing a client: a native app, a sync tool or a script. The web app
uses exactly this API, so anything it does, a client can do.

The contract is [`api/openapi.yaml`](../api/openapi.yaml), OpenAPI 3.1, written by
hand. This page explains what the spec cannot say on its own: how a client
authenticates, how failures look, and how the API changes over time.

## Where the spec and the reference are

- **Every server serves its own spec** at `/api/openapi.yaml`, without signing
  in. It is the spec the binary was built with, so it describes that server
  exactly. Point a code generator or an API tool at it.
- **The rendered reference** is an HTML page built from the spec by redocly.
  Every release attaches it as `yondrive-api-reference.html`. To build it from a
  checkout, `nix develop -c just api-docs` writes `docs/api/index.html`.

The reference is generated, not committed: the spec is the source, a committed
copy of a megabyte of HTML would drift from it, and the release and the
server's own `/api/openapi.yaml` already pin it to a version. CI renders it on
every change, so a spec that does not render fails there. The page reads
without JavaScript; its search and expanding panels load Redoc's script from
its CDN.

## Basics

- Everything is under `/api/v1`. Requests and responses are JSON, apart from
  stored files, which are `application/octet-stream`.
- **Binary fields** (keys, hashes, sealed blobs) are padded standard base64.
  **Times** are RFC 3339 in UTC. **Ids** are 32 lowercase hex characters; for
  nodes, versions, links and the files sent through a request the client chooses them.
- **Lists** take `limit` (default 200, at most 1000) and return `next_cursor`
  while there may be more; pass it back as `cursor`.
- **The server never reads content.** In end-to-end mode, names, metadata, file
  contents, thumbnails and search index segments arrive sealed, and the client
  does all the cryptography in [CRYPTO.md](CRYPTO.md). In mode `none` the same
  fields hold the plain values, with the suite `none`. `GET /api/v1/health`
  says which mode a server is in; a client pins it and refuses a change
  ([CRYPTO.md, mode guard](CRYPTO.md#14-mode-guard)).

## Authentication

There are three kinds of credential, and each route lists which it accepts.

| Credential | Who uses it | How it is sent |
| --- | --- | --- |
| Session cookie `yondrive_session`, `__Host-yondrive_session` over HTTPS | The web app | HttpOnly, `SameSite=Strict`, set by `POST /api/v1/auth/login` |
| Bearer token | Native clients and scripts | `Authorization: Bearer <secret>` |
| Setup token | The first-run wizard only | `X-Setup-Token`, from the link in the server's log |

Public links and file requests are separate: the routes under
`/api/v1/public/links/{id}` and `/api/v1/public/requests/{id}` look at no cookie
and no token, only at `X-Link-Token`, which opening or unlocking one returns.

### Getting a bearer token

A token belongs to one user and one device, and is named so that the user can
see and revoke it in Settings.

1. **Derive the auth key.** `GET /api/v1/auth/kdf?username=…` returns the
   Argon2id parameters. Derive the root from the passphrase and the auth key from
   the root, as [CRYPTO.md section 3](CRYPTO.md#3-passphrase-to-keys) says. The
   passphrase never leaves the device; the server only ever sees the auth key,
   and stores its SHA-256. (For a username that does not exist, the route
   answers stable fake parameters, so it cannot be used to find accounts.)
2. **Sign in.** `POST /api/v1/auth/login` with `username` and `auth_key`, plus
   `totp` if the account has a second factor (the server answers
   `totp_required` until it is given). It sets the session cookie and returns
   the account, including its sealed keys.
3. **Make the token.** `POST /api/v1/me/tokens` with the cookie, a `name` for the
   device and `current_auth_key`, the auth key again. Asking for it again means a
   stolen session cannot mint access that outlives it. The answer holds the
   `secret` once; the server keeps only its hash. Store it in the platform's
   keychain.
4. **Sign out** of the session with `POST /api/v1/auth/logout`, and use the
   token from then on.

A token lasts until the user revokes it (`DELETE /api/v1/me/tokens/{id}`) or
their credentials change. An account that signs in through an identity provider
makes its token from a session the provider started; in end-to-end mode
`current_auth_key` is the auth key of its unlock passphrase
([CRYPTO.md, SSO accounts](CRYPTO.md#sso-accounts)).

A token is not a session: the routes that hold the server half of a browser's
session key (`/api/v1/session/key`) answer `session_required`, as a native client
keeps its own keys. Everything else accepts either.

### Browsers and other origins

State-changing requests that carry the cookie must come from the app's own
origin: the server checks `Sec-Fetch-Site` (or `Origin`) and refuses others. A
request with a bearer token is exempt, and so is one with neither header, which
no browser sends. The server sends no CORS headers: a page on another origin
cannot call the API with a user's cookie, and is not meant to.

### Limits

Everything that checks a credential is rate-limited per client address, and per
username, and answers `429` with `rate_limited` beyond it. Behind a reverse
proxy the address is the visitor's only when the proxy is trusted
([PROXY.md](PROXY.md)). Request bodies have size limits per route, answering
`413` with `too_large`.

## Errors

Every failure is JSON with one field:

```json
{ "code": "version_conflict" }
```

The status says what kind of failure it is; `code` says which. Codes are
stable identifiers, never messages, so a client can branch on them and
translate them. The full list, with what each means, is the description of the
`Error` schema in the spec. A few worth knowing:

| Status | Code | Means |
| --- | --- | --- |
| 401 | `unauthorized` | No valid session or token |
| 401 | `invalid_credentials` | Wrong username or auth key at sign-in, the same answer for both |
| 403 | `forbidden` | Signed in, but not allowed to do this |
| 404 | `not_found` | Does not exist, or the caller may not know that it does |
| 409 | `name_conflict` | A sibling already has this name tag |
| 412 | `version_conflict` | The file's current version moved on since the client read it |
| 409 | `wrong_mode` | The route does not apply in this server's mode |
| 429 | `rate_limited` | Too many attempts; wait and try again |

A response without a JSON body (a dropped connection, a proxy's error page) is
not from YonDrive.

## Versioning

- **The path carries the major version.** `/api/v1` changes only by adding:
  new routes, new optional request fields, new response fields, new error codes.
  A client must ignore fields it does not know and treat an unknown code by its
  status.
- **A breaking change** gets a new prefix, `/api/v2`, served beside `/api/v1`
  for at least one major release of the server, with the removal announced in
  [CHANGELOG.md](../CHANGELOG.md).
- **Which server is this?** `GET /api/v1/health` returns `version` (the
  release, such as `1.0.0`), `commit`, the encryption `mode` and whether setup
  is done. The `info.version` of the served spec is the version of the contract,
  which moves with it.
- **The storage format** of what clients seal has its own version, in the suite
  name (`xchacha20poly1305-v1`), described in [CRYPTO.md](CRYPTO.md#2-suites).

## A client's checklist

- Pin the server's mode on first contact, and the public keys of the people you
  share with ([CRYPTO.md section 15](CRYPTO.md#15-key-pinning)).
- Upload in frames and resume with `GET /api/v1/uploads/{id}`; commit with the
  version you last read, and handle `version_conflict` by saving a copy.
- Follow the change journal (`GET /api/v1/changes`) to stay in sync. A cursor
  older than the journal's retention answers `410 cursor_expired`: read the tree
  again and start over without a cursor.
- Never log a token, a key, an auth key or a sealed blob.
- Send files through a file request with the public key from its URL alone, and
  stop if the one the server answers with differs
  ([CRYPTO.md section 20](CRYPTO.md#20-file-requests)). Adopt what arrives for
  your requests with `GET /api/v1/incoming` and `POST /api/v1/incoming/{id}/adopt`,
  and treat it as untrusted.
