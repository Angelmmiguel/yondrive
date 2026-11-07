# Architecture

How the server is built: storage, the API and the account flows. The decisions
behind it are in [PLAN.md](../PLAN.md), the formats in [CRYPTO.md](CRYPTO.md) and
the threat model in [SECURITY.md](SECURITY.md). The contract is
[`api/openapi.yaml`](../api/openapi.yaml).

## Packages

| Package | Holds |
| --- | --- |
| `internal/store` | SQLite and migrations. Reads and writes records atomically and decides nothing. |
| `internal/blobs` | Stored files: ids to paths, frames at offsets, atomic moves. No database and no HTTP. |
| `internal/auth` | Hashing, tokens, fake KDF salts, session keys, rate limits, TOTP. No database and no HTTP. |
| `internal/api` | Generated from the spec. Never edited. |
| `internal/server` | Handlers, middleware, and what each route is allowed to do. |
| `cmd/yondrive` | `serve`, `backup` and `admin`. |

## Storage

Everything is in the data directory, set through the environment and never
through the API:

```
yondrive.db       SQLite in WAL mode: accounts, settings, audit trail, the tree, the journal
blobs/ab/<id>     one stored file per version, thumbnail or index segment
uploads/<id>      versions being uploaded
uploads/tmp-*     small files on their way in, removed at startup
lock              advisory lock against a second process
```

- **Lock.** `store.Open` takes an exclusive `flock` and fails with `ErrLocked` if
  it cannot, so `yondrive admin` refuses to run beside a live server. That also
  lets the server keep the fixed mode in memory. `yondrive backup` alone does not
  take it, and only reads and records the time of the backup.
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
| `settings` | Key and value: name, public URL, default quota, language, time zone, open sign-up, grace period, trash retention, last backup, the mode and the server secret. Triggers refuse any change to `mode` once written. |
| `users` | Identity, role, quota, KDF parameters, auth key hashes, opaque blobs, TOTP state. The KDF and auth columns are nullable and `oidc_issuer` and `oidc_subject` are present for accounts that will sign in through a provider. |
| `recovery_codes` | SHA-256 of each unused TOTP recovery code. |
| `sessions` | SHA-256 of the cookie, user, idle and absolute deadlines. |
| `tokens` | SHA-256 of each device's bearer token, its name and last use. |
| `invites` | SHA-256 of the token, email, role, quota, expiry and use. |
| `password_resets` | SHA-256 of the token, user and expiry. At most one per user. |
| `audit` | Time, action, actor id, target id, address. Survives deleting the user. |
| `nodes` | Owner, parent, kind, suite, opaque metadata, wrapped key and name tag, current version, trash and removal times. |
| `versions` | Node, blob, author, the id it was sealed as and its signer, sizes, frame hashes, opaque signature and manifest. |
| `blobs` | Owner, node if any, kind, suite, size, ref count. |
| `uploads`, `upload_frames` | Uploads in progress and the digest of each frame that has arrived. |
| `changes` | The journal: sequence, owner, node, operation, time. |
| `file_removals` | Files whose rows have gone, waiting to be unlinked. |

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
PATCH  /admin/settings                  everything but the mode; shortening the grace
                                        period needs the current auth key
GET    /admin/health                    storage, free space, last backup
GET    /me/storage                      quota, used, reserved
GET    /nodes/root
POST   /nodes/root                      make it, or get the one that exists
POST   /nodes                           client-chosen id
GET    /nodes/{id}
PATCH  /nodes/{id}                      metadata, name tag
GET    /nodes/{id}/children?cursor=     by id
POST   /nodes/{id}/move                 parent, wrapped key, name tag
POST   /nodes/{id}/trash
POST   /nodes/{id}/restore              also cancels a purge
POST   /nodes/{id}/purge                marks; the grace period follows
GET    /trash?cursor=
POST   /trash/empty
GET    /nodes/{id}/versions?cursor=     newest first
GET    /nodes/{id}/versions/{vid}       with frame hashes, signature, manifest
DELETE /nodes/{id}/versions/{vid}       not the current one; marks
POST   /nodes/{id}/versions/{vid}/restore
POST   /uploads
GET    /uploads/{id}
DELETE /uploads/{id}
PUT    /uploads/{id}/frames/{n}
POST   /uploads/{id}/commit
GET    /blobs/{id}                      Range
PUT    /blobs/{id}?kind=&suite=&node_id=  thumbnail or index segment
DELETE /blobs/{id}                      thumbnail or index segment
GET    /me/index?cursor=                index segments
GET    /changes?cursor=
```

**Who may call what.** `guard` is a middleware on every generated operation, and
`operationAccess` lists the ones that do not need a signed-in user. An operation
missing from the table needs a session, so a new route cannot become public by
being forgotten.

**Middleware**, outermost first: panic recovery, a request log (never bodies or
query strings), a deadline on the request body (per frame on the frame and small blob
routes, 5 minutes, instead of 2), security headers, the same-origin check for
state-changing requests, a cap on the body (16 MiB and overhead on those routes, 1 MiB elsewhere). The same-origin check skips
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

**Proxies.** Forwarded headers from an address outside `YONDRIVE_TRUSTED_PROXIES` are
ignored. The admin settings routes report `proxy_untrusted` when a request carries them,
so the admin area can warn about the most likely misconfiguration.

At 65,536 tracked keys a limiter forgets the window closest to ending, so a spray of
addresses cannot clear the limits on anyone else.

**Audit.** Security events only: ids, the action and the address. Never content or
secrets, and never the username typed at a failed sign-in, since people type
passwords there. A failed audit write is logged and undoes nothing.

## Drive

Everything here is opaque to the server in both modes. It checks sizes, encodings and that
every item's suite is the one of its mode, and parses nothing.

**Ids.** Nodes, versions and small blobs have ids that the client chooses, because they enter
the AAD before sealing. Each is checked for its form before anything else, and refused if it
is in use, with `id_taken`. Uploads get theirs from the server, which is also the id of the
blob they become. Every path on disk is built by `internal/blobs` from an id it has checked
itself.

**The tree.** A root is made on demand by a client, since only a client can wrap its key under
the master key, and the first device to ask wins. A name tag is unique among the siblings
outside the trash. A move replaces the wrapped key and the name tag in the transaction that
moves the node, and checks for cycles in it, so that two crossing moves cannot both succeed.
A tree stops at 256 levels: deleting one relies on foreign key cascades, which SQLite limits
to 1000 levels, and a deeper tree could never be deleted, nor could its owner.

**Who may do what.** `canAccess` is the one place that decides: today the owner, and grants
go there in the next phase. What it refuses answers exactly as what does not exist, `404`,
and blobs and uploads are reached through their node.

**Trash, purge and the grace period.** Trashing sets a time on the root of the subtree alone,
and what is under it stays readable and frozen. A client's purge only marks: it sets
`remove_at`, the grace period from now, and that time is fixed then, so shortening the setting
later hastens nothing already marked. Until then the bytes stay and count, and restoring cancels
it. So a stolen session cannot destroy anything sooner than that, and a stolen admin session
needs a current auth key to shorten the setting. Deleting a version works the same way. Deleting
a user is immediate.

**Versions and blobs.** A version points at a blob, whose `ref_count` triggers maintain. Restoring
adds a version over the same blob. Because the frames stay sealed under the id they were written
with, a version carries that id and its signer too (CRYPTO.md, section 12). `current_version`
moves under an optimistic check: `expected_version` answers `412 version_conflict` on a mismatch.

**Quota.** `used_bytes` and `reserved_bytes` on the user are kept by triggers on `blobs` and `uploads`,
so a row removed by a cascade releases its bytes like any other. An upload reserves its size when
created, and the commit changes reserved to used in one transaction. The owner of the node is charged.

**Uploads.** Create, then send frames in any order, then commit:

```
POST   /uploads                        reserve; the file is made at its full size, sparse
PUT    /uploads/{id}/frames/{n}        checks length and SHA-256, writes at its offset, syncs, records
GET    /uploads/{id}                   which frames are present
POST   /uploads/{id}/commit            signature and manifest; moves the file, adds the version
DELETE /uploads/{id}                   release
```

A frame's length follows from the framing, with 41 bytes of overhead in `e2e` mode. A frame that
has been recorded never changes: the same digest again is a retry and another digest is
`frame_conflict`. A per-frame lock keeps two writers off the same offset. So no writer can be
touching a file whose frames are all recorded, which is what makes the commit safe. The commit
runs its checks, moves the file and adds the rows inside one write transaction.

**Removing files.** Triggers queue each deleted blob and upload in `file_removals`, in the
transaction that deletes it, however it got deleted. Files are unlinked from that queue, so that a
crash cannot lose one. The write connection runs with `synchronous=FULL` because files move and go
on the strength of commits.

**Sweeper.** Once an hour, and at startup: it purges what the trash has held for
`trash_retention_days`, removes what has reached `remove_at`, drops uploads untouched for a week,
and works through `file_removals`.

**Startup.** Before serving, the server brings the files into line with the database. It removes
temporary files; moves back a file whose commit never finished, for the client to commit again;
removes other files with no row; and forgets uploads whose file is gone, which also releases
what they reserved. Uploads in progress survive a restart.

**Downloads.** `http.ServeContent` with `Range`, always `application/octet-stream` as an attachment,
`private, no-store`, `nosniff` and a sandboxing CSP, since these bytes come from a user. Frame hashes
come with the version.

**Small blobs.** Thumbnails and index segments use the same files, up to 16 MiB, in one request. A
thumbnail hangs off its node and replaces the last one, and an index segment off its user. Both
count against quota. A client can make them again, so they have no grace period.

**Journal.** `changes` holds a sequence, owner, node, operation and time. Writes are serialised, so
sequence numbers appear in commit order and a stored cursor misses nothing. An operation on a
subtree appears once, on its root.

## Backup

`yondrive backup [--data dir] <dest>` works beside a running server, which holds the directory's
lock, so it opens the database with no lock and refuses a schema other than its own. It takes a
snapshot with `VACUUM INTO`, as of one moment, then hard-links the files that snapshot names, or copies
them across filesystems. A blob never changes and is unlinked only after its row has gone, so a
missing file means the server removed it after the snapshot, and the backup starts over with a newer
one, up to five times. The database takes its final name last: a directory without `yondrive.db`
is an unfinished backup. The time goes in the settings, and `GET /admin/health` shows it.

To restore, stop the server and use the directory as the data directory. Uploads in progress are not
in a backup; the server forgets them on startup, and clients start them again.

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
Three actions need the admin's current auth key as well as a session, because a stolen
admin session could otherwise keep or widen its reach, or destroy what it has no right to: an
invite with the `admin` role, which mints an admin that outlives the session, a password
reset link, which takes over an account, and deleting a user, which removes their bytes at
once, with none of the purge grace. Ordinary invites do not.

## Web app

The layers of the account flows, each knowing only the one below:

| Where | Holds |
| --- | --- |
| `src/routes` | Thin glue: forms, and which flow to call. |
| `src/lib/app` | What runs at page load (`boot`), where the session belongs (`destinationFor`). |
| `src/lib/account` | The flows, pure, with what they reach outside for injected through `Deps`. |
| `src/lib/state` | The session and toasts, in `.svelte.ts` modules. Keys live here, in memory only. |
| `src/lib/crypto` | The primitives and the `Sealer`. |
| `src/lib/api` | One function per route, on the generated schema. Knows nothing about crypto. |

**One path for both modes.** A flow asks the `Sealer` for everything that differs: in `none`
it hands back empty byte strings, which flow through untouched, and the wire layer leaves out
what is empty and reads what is absent as empty. A flow never reads the mode. A screen reads
`sealer.encrypted`, and only to show or skip what exists solely with keys: unlock, lock, the
recovery steps, the password reset button and the "Not encrypted" indicator.

**The guard.** Every flow gets its sealer from `acceptMode`, which runs `decideMode` on what
the server claims and what the account holds, and pins the mode on a new device. It runs at
page load on health, and again on the account at sign-in, recovery, unlock and resume. A
refusal zeroes the keys and sets `session.refusal`, and the root layout then draws only the
blocking alert. A refused sign-in also ends the session it just got.

**Page load.** `boot` asks health. No setup: `/setup`, which without a token only says to use
the link from the logs. No session: `/signin`. A session and both halves of the session key:
the app. A session without them: `/unlock`. In `none` there is nothing to reopen, so a session
is simply open. The root layout draws a page only once the session belongs on it.

**Lock.** Zeroes the keys in place, forgets the sealed half, tells the other tabs on a
`BroadcastChannel` and deletes the server's half, in that order, so that it never waits on the
network. A flow holding a key across a wait fails with `LockedError`, or `ZeroKeyError` from
the construction, and an unlock still storing its half when a lock arrives undoes it.
`sessionStorage` is per tab, so each tab unlocks on its own, and the last to do so holds the
server's half: another tab that reloads then asks for the passphrase.

**New recovery keys** are shown and typed back before anything happens to the old one. In
recovery and in settings the rekey is the last step, so nobody can be left holding a key they
never saw. A pending key lives in memory, so a reload makes a new one.

**The display name** typed in the wizard and in settings stays in `localStorage`. The API has
no field for it, and the canary test checks that it never leaves the device.

Browser specs start a throwaway server per file (`web/tests/server.ts`) and drive the wizard
through the app. `YONDRIVE_E2E_BIN` names a binary already built, with the app embedded, when
the working tree does not build.
