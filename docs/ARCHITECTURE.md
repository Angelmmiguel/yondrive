# Architecture

How the server is built: storage, the API and the account flows. The decisions
behind it are in [PLAN.md](../PLAN.md), the formats in [CRYPTO.md](CRYPTO.md) and
the threat model in [SECURITY.md](SECURITY.md). The contract is
[`api/openapi.yaml`](../api/openapi.yaml).

## Packages

| Package | Holds |
| --- | --- |
| `internal/store` | SQLite and migrations. Reads and writes records atomically and decides nothing. |
| `internal/auth` | Hashing, tokens, fake KDF salts, session keys, rate limits, TOTP. No database and no HTTP. |
| `internal/api` | Generated from the spec. Never edited. |
| `internal/server` | Handlers, middleware, and what each route is allowed to do. |
| `cmd/yondrive` | `serve` and `admin`. |

## Storage

Everything is in the data directory, set through the environment and never
through the API:

```
yondrive.db    SQLite in WAL mode: accounts, settings, audit trail
lock           advisory lock against a second process
```

- **Lock.** `store.Open` takes an exclusive `flock` and fails with `ErrLocked` if
  it cannot, so `yondrive admin` refuses to run beside a live server. That also
  lets the server keep the fixed mode in memory.
- **Connections.** One writer connection serialises writes, with immediate
  transactions, so a write never fails on a lock held by another. Reads use their
  own `query_only` pool and see the last commit. Foreign keys are on, with a
  5 s busy timeout. The files are mode 0600 in a 0700 directory.
- **Migrations.** `internal/store/migrations/NNNN_*.sql`, embedded and applied in
  order, each in a transaction with the bump of `PRAGMA user_version`. A database
  newer than the binary is refused.
- **Times** are Unix seconds. **Ids** are 32 hex characters.

| Table | Holds |
| --- | --- |
| `settings` | Key and value: name, public URL, default quota, language, time zone, open sign-up, the mode and the server secret. Triggers refuse any change to `mode` once written. |
| `users` | Identity, role, quota, KDF parameters, auth key hashes, opaque blobs, TOTP state. The KDF and auth columns are nullable and `oidc_issuer` and `oidc_subject` are present for accounts that will sign in through a provider. |
| `recovery_codes` | SHA-256 of each unused TOTP recovery code. |
| `sessions` | SHA-256 of the cookie, user, idle and absolute deadlines. |
| `tokens` | SHA-256 of each device's bearer token, its name and last use. |
| `invites` | SHA-256 of the token, email, role, quota, expiry and use. |
| `password_resets` | SHA-256 of the token, user and expiry. At most one per user. |
| `audit` | Time, action, actor id, target id, address. Survives deleting the user. |

Session keys are not in this list. They are memory only.

## API

Spec first: change `api/openapi.yaml`, run `just api`, implement the generated
strict interface. Everything is under `/api/v1`, and errors are
`{"code":"<stable_code>"}`. Handlers return a coded error and one place writes it,
so anything else becomes an opaque 500 and a log line.

```
GET    /health                          liveness, setup, mode
GET    /setup/info                      setup token: data dir, free space
POST   /setup/validate-url              setup token: normalise, warn on http
POST   /setup/complete                  setup token: settings, first admin, mode
GET    /auth/kdf?username=              stored or fake parameters
POST   /auth/login                      either auth key, TOTP if on -> cookie, account
POST   /auth/logout                     ends the session, or revokes the token
POST   /auth/register                   invite or open sign-up
POST   /auth/rekey                      current auth key + new credentials
POST   /auth/password-reset             none mode: reset token + new credentials
POST   /auth/totp/enrol                 current auth key -> secret
POST   /auth/totp/confirm               code -> recovery codes
POST   /auth/totp/disable               current auth key + code
PUT    /session/key                     32 bytes, memory only
GET    /session/key
DELETE /session/key                     the client locked
GET    /me                              the same account document as login
GET    /me/tokens
POST   /me/tokens                       current auth key -> bearer token
DELETE /me/tokens/{id}
GET    /users/{id}/keys                 public keys
GET    /admin/users
PATCH  /admin/users/{id}                disable, enable, quota
DELETE /admin/users/{id}
POST   /admin/users/{id}/password-reset none mode, current auth key
GET    /admin/invites
POST   /admin/invites                   -> token and link, once; admin role needs
                                        the current auth key
DELETE /admin/invites/{id}
GET    /admin/settings
PATCH  /admin/settings                  everything but the mode
```

**Who may call what.** `guard` is a middleware on every generated operation, and
`operationAccess` lists the ones that do not need a signed-in user. An operation
missing from the table needs a session, so a new route cannot become public by
being forgotten.

**Middleware**, outermost first: panic recovery, a request log (never bodies or
query strings), a deadline on the request body, security headers, the same-origin
check for state-changing requests, a cap on the body. The same-origin check skips
requests with an `Authorization: Bearer` header. Such a request is then
authenticated by that header alone, even if it also carries a cookie, so a forged
header cannot reach the cookie past the check.

**Rate limits**, fixed windows per client address, in memory: 10 a minute by default
on everything that checks a credential (login, registration, rekey, password reset,
minting a token, enrolling and disabling TOTP, an admin invite, issuing a reset) and six times that on the KDF route.
Wrong setup tokens count, right ones do not. Guesses at a second factor are also
limited per user, since they come only with the right auth key and no stranger can
use that to lock anyone out. The address is the connection's peer, or the last
`X-Forwarded-For` entry from a peer in `YONDRIVE_TRUSTED_PROXIES`. IPv6 clients count as
their /64, since one client usually holds all of it. Logs and the audit trail keep the
full address.

Sign-in is also limited per username, at five times the address limit, for guessing
spread over many addresses. It counts existing and unknown names alike, so it does not
say who has an account. A stranger with several addresses can spend it to refuse someone's
sign-ins, for one window at a time; open sessions and tokens are not affected. That is
why the threshold is high and the window short, and why there is no longer lockout.

At 65,536 tracked keys a limiter forgets the window closest to ending, so a spray of
addresses cannot clear the limits on anyone else.

**Audit.** Security events only: ids, the action and the address. Never content or
secrets, and never the username typed at a failed sign-in, since people type
passwords there. A failed audit write is logged and undoes nothing.

## Account flows

The server sees auth keys and stores their SHA-256. A slow hash would add nothing:
guesses at a passphrase already cost the client's Argon2id, and the recovery auth key
derives from 256 random bits. Everything else about an account is a blob it checks only
for encoding and size. The formats are in [CRYPTO.md](CRYPTO.md).

**Setup.** On an unconfigured server `serve` generates a token, prints a link to the
logs with the token in the fragment, and passes the token to the server, which keeps
only its hash. A restart issues a new one. `setup/complete` writes the settings and
first admin in one transaction, which also decides between racing calls. The token dies
with that commit, as all setup routes answer `already_setup` from then on.

**Mode.** Written once in that transaction. No route, request field or store method can
change it, and triggers refuse it in the schema. The mode decides what an account must
hold: `e2e` requires the recovery auth key and all blobs and `none` refuses them.

**Sign-in.** The client fetches KDF parameters, derives the auth key and calls login.
An unknown username gets parameters of the same shape, the new-account defaults with a
salt from an HMAC under the persisted server secret, stable across restarts. Unknown
username, wrong key and malformed key answer the same `invalid_credentials`, and
comparison treats a missing hash like a wrong one. Only the right key learns
`user_disabled` or `totp_required`. Login returns the account document, and `GET /me`
returns it again so that a locked client can unlock.

**Sessions.** A random token in an HttpOnly, SameSite=Strict cookie, `Secure` as
`YONDRIVE_SECURE` says, with a 24 h idle and a 7 day absolute lifetime. The database
holds its hash, so a restart keeps people signed in. The idle deadline moves on use, at
most once a minute.

**Session key.** The server half of the split key is in a map keyed by session hash, in
memory and never written anywhere. It goes on logout, lock, expiry and revocation, and a
minute-by-minute purge wipes keys of sessions nobody came back to. After a restart it is
gone, so the session lives on and the client asks for the passphrase. Bearer tokens have
no session and are refused here, as native clients keep their own keys.

**Registration.** With an invite (one-time, expiring, with optional email, role and
quota) or, if the admin turned it on, freely. The invite is checked before anything
else, so nothing about usernames is learnt without one, and burnt in the transaction
that creates the user: a refused registration does not use it up.

**Rekey and recovery.** A lost passphrase is recovered by signing in with the recovery
auth key, opening the recovery wrap on the client, and rekeying. Rekey needs a live
session or token and a current auth key, either one: a session alone must not be able
to replace wrapped keys. The passphrase group (auth key, KDF, wrapped key) and the
recovery group (auth key, wrapped key) are each all or nothing. One transaction replaces
them and ends every other session and every token but the one in use.

**One lock.** Login, rekey, password reset, TOTP changes, and disabling and deleting
users hold `accountMu` from reading a credential to acting on it. A login racing a rekey
lands wholly before it, and its session is revoked, or wholly after it, and is refused.
Two admins disabling each other cannot both succeed, because each re-reads the other
under the lock.

**Password reset.** Only in `none` mode, where no key depends on the password. An admin
issues a one-time link good for a day, and using it replaces the credentials and ends all
of the user's access. In `e2e` mode both routes answer `wrong_mode`.

**TOTP.** RFC 6238 with HMAC-SHA1, six digits, 30 s, one step of skew. The secret is
stored readable by the server: it protects sign-in only and decrypts nothing. A conditional
update on the last used step makes a code single-use under concurrency. Enrolling and
disabling need a current auth key, so that a stolen session cannot lock the owner out or
weaken the account. Ten recovery codes, 80 random bits each, stored hashed and shown once.
For someone who lost both, `yondrive admin reset-totp <username>` works from the host with
the server stopped.

**Device tokens.** Named per device and revoked one at a time. Minting one needs a current
auth key, so that a stolen session cannot outlive itself.

**Admins.** An admin cannot disable or delete themselves, so a server always has one who
can sign in. Reading a user's blobs is not among the things an admin can do through the API.
Two actions need the admin's current auth key as well as a session, because a stolen
admin session could otherwise keep or widen its reach: an invite with the `admin` role,
which mints an admin that outlives the session, and a password reset link, which takes
over an account. Ordinary invites do not.
