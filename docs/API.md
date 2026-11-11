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
| Session cookie `yondrive_session`, `__Host-yondrive_session` over HTTPS | The web app | HttpOnly, `SameSite=Strict`, set by `POST /api/v1/auth/login` (a native client uses `/auth/device-login` instead and gets no cookie) |
| Bearer token | Native clients and scripts | `Authorization: Bearer <secret>` |
| Setup token | The first-run wizard only | `X-Setup-Token`, from the link in the server's log |

Public links and file requests are separate: the routes under
`/api/v1/public/links/{id}` and `/api/v1/public/requests/{id}` look at no cookie
and no token, only at `X-Link-Token`, which opening or unlocking one returns.

### Devices

A token belongs to one user and one device, and is named so that the user can
see and revoke it in Settings → Devices. A native client gets one in either of
two ways, and never through a session cookie.

#### Sign in with a passphrase

```
GET /api/v1/auth/kdf?username=angel
→ {"name":"argon2id","m":65536,"t":3,"p":1,"salt":"…"}

root     = Argon2id(NFKC(passphrase), salt, m, t, p, 32)
auth key = HKDF-SHA256(root, "yondrive/auth/v1")      (CRYPTO.md §3)
KEK      = HKDF-SHA256(root, "yondrive/kek/v1")       stays on the device

POST /api/v1/auth/device-login
{"username":"angel","auth_key":"<base64 32 bytes>","device":{"name":"Angel's phone","platform":"ios"}}
→ 401 {"code":"totp_required"}            (if two-factor is on)

POST /api/v1/auth/device-login
{…same…,"totp_code":"123456"}
→ 201 {"account":{…Account…},"token":{"id":"…","name":"Angel's phone","platform":"ios","origin":"login","created_at":"…"},"secret":"<43 chars>"}
```

The passphrase never leaves the device; the server only ever sees the auth key,
and stores its SHA-256. For a username that does not exist, the KDF route answers
stable fake parameters, so it cannot be used to find accounts. `totp_recovery_code`
takes the place of `totp_code`. The same limits and codes apply as at
`POST /api/v1/auth/login`, plus `invalid_token_name`, `invalid_platform` and
`device_limit_reached` (24 tokens per user).

Then: run the mode guard ([CRYPTO.md section 14](CRYPTO.md#14-mode-guard)) with
`account.mode` and `account.keys`; in `e2e` open `account.keys.wrapped_master_key`
with the KEK under purpose `passphrase` (§5), open the identity keys (§6), and zero
the KEK. Keep `secret` and the master key in the keychain. Send
`Authorization: Bearer <secret>` on every request. Never log the secret, the auth
key or the master key.

An account that signs in through an identity provider has no passphrase to sign
in with here, and pairs by code instead.

#### Pair by code

A signed-in browser shows a QR code in Settings → Devices, after the user confirms
a current credential. The device:

1. Scans it. Parses `https://<server>/pair#1.<id>.<P_b>`: the server address is
   the URL's origin; `<id>` is 32 lowercase hex; `P_b` is unpadded base64url, 32
   bytes, not all zeros. It refuses any other version. `P_b` stays on the device:
   never send it to a server.
2. Draws `d`, `P_d` (X25519).
3. `POST <server>/api/v1/pairings/<id>/claim`
   `{"public_key":"<base64 P_d>","name":"Angel's phone","platform":"ios"}`
   → `200 {"status":"claimed","expires_at":"…"}`. `404 pairing_invalid` (unknown,
   expired or cancelled) and `409 pairing_claimed` (another device was first) end
   the attempt.
4. Shows the code: `SHA-256(fields("yondrive/pairing/code/v1", P_b, P_d, utf8(id)))`,
   first four bytes big-endian, `% 1000000`, six digits
   ([CRYPTO.md section 22](CRYPTO.md#22-device-pairing)). The user checks that the
   browser shows the same, and confirms there.
5. Polls `GET <server>/api/v1/pairings/<id>` every two seconds until
   `status` is `confirmed`; `pairing_invalid` means cancelled or expired. It has
   two minutes from the confirmation to collect.
6. Opens `sealed_payload`: `shared = X25519(d, P_b)`;
   `wrap = HKDF(shared, fields("yondrive/pairing/key/v1", P_b, P_d))`;
   `aad = fields("yondrive/pairing/payload/v1", P_b, P_d, utf8(id))`;
   `Open(wrap, sealed, aad)` → JSON `{"v":1,"suite":…,"token":…,"master_key"?:…}`.
7. `GET /api/v1/health` → mode. Mode guard: a payload with `master_key` is an
   account with keys, and a server that claims `none` is refused. Pin the suite.
8. `GET /api/v1/me` with `Authorization: Bearer <token>` → `Account`. In `e2e`,
   opens `keys.sealed_x25519` and `keys.sealed_ed25519` with `master_key` (§6);
   the recomputed public keys must match. Keeps the token and the master key in
   the keychain, and zeroes `d`, `shared` and `wrap`.

Primitives a device needs: X25519, HKDF-SHA256, SHA-256, Argon2id,
XChaCha20-Poly1305 and Ed25519.

#### Afterwards

- `GET /api/v1/me/tokens`: the entry with `"current": true` is this device.
- `POST /api/v1/auth/logout` with the token revokes it (signing out on the device).
- `401 unauthorized` on any request: the token was revoked or the credentials
  changed. Delete the token and the keys from the keychain and show the start
  screen.
- Actions that take `current_auth_key` ask the user for the passphrase and derive
  it with the `kdf` from `GET /api/v1/me`. An account that signs in through a
  provider, on a server without encryption, cannot take them from a device.
- `/api/v1/session/key` answers `session_required`: it holds the server half of a
  browser's session key, and a device keeps its own keys. Everything else accepts
  either.

Scripts can still have a token made in Settings (`POST /api/v1/me/tokens` with a
session, a `name` and `current_auth_key`), whose secret is shown once. A token
lasts until the user revokes it (`DELETE /api/v1/me/tokens/{id}`) or their
credentials change.

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
| 404 | `pairing_invalid` | A pairing code that is unknown, expired or cancelled, to a device |
| 409 | `pairing_claimed` | Another device claimed this pairing code first |
| 409 | `pairing_not_claimed`, `pairing_already_confirmed` | Confirming a pairing before a device claimed it, or twice |
| 410 | `pairing_expired` | The pairing's time is up, to the browser that started it |
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
- Never send the key from a pairing code to the server; it is what makes the code
  trustworthy.
- Send files through a file request with the public key from its URL alone, and
  stop if the one the server answers with differs
  ([CRYPTO.md section 20](CRYPTO.md#20-file-requests)). Adopt what arrives for
  your requests with `GET /api/v1/incoming` and `POST /api/v1/incoming/{id}/adopt`,
  and treat it as untrusted.
- Read a file's comments with `GET /api/v1/nodes/{id}/comments`, verify each
  signature and the author's right to comment before showing it, and show its
  text as plain text ([CRYPTO.md section 21](CRYPTO.md#21-comments)). A
  `commented` entry in the journal says a file's comments changed.
