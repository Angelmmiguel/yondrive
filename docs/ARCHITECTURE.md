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
| `internal/oidc` | The client of an identity provider: discovery, PKCE, the code exchange and ID token verification, on the standard library. `oidctest` is a fake provider for tests. No database and no routes. |
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
| `settings` | Key and value: name, public URL, default quota, language, time zone, open sign-up, grace period, trash retention, audit and journal retention, whether local accounts are on, the provider's settings with its client secret, last backup, the mode and the server secret. Triggers refuse any change to `mode` once written. |
| `users` | Identity, role, quota, KDF parameters, auth key hashes, opaque blobs, TOTP state. `oidc_issuer` and `oidc_subject` are the identity at a provider. An account that signs in only that way has no `auth_key_hash`, and `unlock_auth_key_hash` proves its current credential. |
| `recovery_codes` | SHA-256 of each unused TOTP recovery code. |
| `sessions` | SHA-256 of the cookie, user, idle and absolute deadlines. |
| `tokens` | SHA-256 of each device's bearer token, its name and last use. |
| `invites` | SHA-256 of the token, email, role, quota, expiry and use. |
| `password_resets` | SHA-256 of the token, user and expiry. At most one per user. |
| `audit` | Time, action, actor id, target id, address. Survives deleting the user. |
| `nodes` | Owner, parent, kind, suite, opaque metadata, wrapped key and name tag, current version, key generation, trash and removal times. |
| `node_key_history` | The key of each past generation of a node, sealed under the next. |
| `versions` | Node, blob, author, the id it was sealed as and its signer, key generation, sizes, frame hashes, opaque signature and manifest. |
| `grants` | Node, grantee, granter, role, key generation, sealed key, signature, when it was read. |
| `links` | Node, owner, key generation, sealed keys, KDF parameters and auth hash of a password, expiry, download limit and count, revocation. |
| `link_downloads` | What each link's sessions have counted. |
| `blobs` | Owner, node if any, kind, suite, size, ref count. |
| `uploads`, `upload_frames` | Uploads in progress and the digest of each frame that has arrived. |
| `changes` | The journal: sequence, the user whose journal it is, node, operation, time. `users.journal_floor` is the highest sequence trimmed from each. |
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
GET    /auth/methods                    what the sign-in page offers
GET    /auth/oidc/start?fresh=          -> the provider, with the flow cookie
POST   /auth/oidc/start                 invite token -> where to go, with the flow cookie
GET    /auth/oidc/callback              at the root, not under /api/v1 -> session, /
POST   /auth/oidc/enrol                 once, with the session: the keys of an SSO account
POST   /oidc/test                       setup token or admin: discovery and keys of an issuer
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
DELETE /admin/users/{id}/identity       current auth key: forget the provider identity
POST   /admin/users/{id}/password-reset none mode, current auth key
GET    /admin/invites
POST   /admin/invites                   -> token and link, once; admin role needs
                                        the current auth key
DELETE /admin/invites/{id}
GET    /admin/settings
PATCH  /admin/settings                  everything but the mode; shortening the grace
                                        period needs the current auth key
GET    /admin/health                    storage, free space, last backup, history sizes
GET    /admin/audit?cursor=             the audit trail, newest first
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
GET    /users/lookup?username=          exact match only, limited
POST   /grants                          owner: sealed key, signature
GET    /grants?cursor=                  made by me, with their nodes
PATCH  /grants/{id}                     owner: role, signature
DELETE /grants/{id}                     owner, or the holder
GET    /nodes/{id}/grants               on the node and above it
POST   /nodes/{id}/rotate               owner: one transaction
GET    /shared-with-me?cursor=          held by me, with their nodes
GET    /notifications                   unread grants: ids only
POST   /notifications/read
POST   /links                           owner
GET    /links?cursor=                   made by me, with their nodes
POST   /links/{id}/revoke
DELETE /links/{id}
GET    /public/links/{id}               state, or open with a token
POST   /public/links/{id}/unlock        auth key of the password -> open with a token
GET    /public/links/{id}/nodes/{nid}   X-Link-Token, as all below
GET    /public/links/{id}/nodes/{nid}/children?cursor=
GET    /public/links/{id}/nodes/{nid}/version    the current one
GET    /public/links/{id}/blobs/{bid}   Range
```

**Who may call what.** `guard` is a middleware on every generated operation, and
`operationAccess` lists the ones that do not need a signed-in user. An operation
missing from the table needs a session, so a new route cannot become public by
being forgotten.

**Middleware**, outermost first: panic recovery, a request log (never bodies or
query strings), a deadline on the request body (per frame on the frame and small blob
routes, 5 minutes, instead of 2), security headers, the same-origin check for
state-changing requests, a cap on the body (16 MiB and overhead on those routes and on a rotation, 1 MiB elsewhere). The same-origin check skips
requests with an `Authorization: Bearer` header. Such a request is then
authenticated by that header alone, even if it also carries a cookie, so a forged
header cannot reach the cookie past the check.

**Rate limits**, fixed windows per client address, in memory: 10 a minute by default
on everything that checks a credential (login, registration, rekey, password reset,
minting a token, enrolling and disabling TOTP, an admin invite, issuing a reset) and six times that on the KDF route.
Looking up a username takes three times that per user and per address. A link's password takes the
default per address and five times it per link, both counted on its state as well as on an attempt, and
opening any link six times it per address.
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

**Audit.** Security events only, grants, rotations and links among them: ids, the action and the address. Never content or
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

**Who may do what.** `effectiveRole` is the one place that decides, and `authorizeNode` the way to
it. An owner may do anything. Anyone else has the strongest role a grant gives them on the node or
above it, found by a walk bounded by the depth a tree can reach, and none while the node or anything
above it is in the trash. No role answers exactly as what does not exist, `404`. A role that does
not allow this answers `403`. Blobs and uploads are reached through their node.

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

**Quota.** `used_bytes` and `reserved_bytes` on the user are kept by triggers on `blobs`, `uploads` and `nodes`,
so a row removed by a cascade releases its bytes like any other. An upload reserves its size when
created, and the commit changes reserved to used in one transaction. The owner of the node is charged,
whoever is uploading. A node's sealed metadata counts as used too, so a tree of empty nodes is not free:
creating a node, renaming it and rotating it are refused with `quota_exceeded` when the metadata would not fit.

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

**Journal.** `changes` holds a sequence, a user, node, operation and time, with one row per user who
can reach the node when it happens: the owner and everyone with a grant on it or above it. So reading
needs no walk, and it says what someone could reach then and not what they can now. Writes are
serialised, so sequence numbers appear in commit order and a stored cursor misses nothing. An operation
on a subtree appears once, on its root, except to those with a grant under it, who cannot see the root:
trashing and restoring appear to them on the node of the grant.

A trigger on `grants` adds `revoked` for its grantee, however the row goes, including with its node or
its owner. A move adds it for whoever could reach the node only through where it was. It means a way of
reaching the node has ended, which may not have been the last: a client reads the node, and drops it and
what is under it if the answer is `404`.

## Sharing

What is sealed is opaque here as well. The server checks sizes against the mode, and holds no key. The
constructions are in [CRYPTO.md](CRYPTO.md), sections 8 and 19.

**Roles.** A viewer reads, including older versions. An editor also creates, renames, moves, uploads
versions, restores a version and trashes, and is charged nothing. Only an owner shares, rotates, restores
from the trash, purges or deletes versions; what is in the trash is hidden from everyone else, so an editor
cannot undo trashing. A root cannot be shared, as it holds the owner's tags and has no parent to wrap under.

**The node of a grant** lives in a folder its grantee may not see. Its `parent_id` and `name_tag` do not
show, and `wrapped_key` is empty. What changes that folder, which is a rename, a move or trashing, needs
write access to the parent. So an editor of a shared folder can write to its metadata and contents, and
not take it from where it is. A holder who is done with it gives up the grant instead.

**Moves.** A move stays within the owner. An editor's also stays within one grant: a grant of theirs must
cover both the old parent and the new one, so two separate shares from one owner stay separate. This is
checked in the transaction of the move, since the owner may be moving the same folders. An owner may move a
subtree in and out of what they share, and roles follow where it is now.

**Revoking** ends access with the commit, and uploads the user can no longer finish stop holding the owner's
quota, whether the grant went, the node moved out of what it covered, or the node went to the trash. The
user can also abort their own upload wherever it is. The rest is the client's: `POST /nodes/{id}/rotate` replaces a node's key, the wraps and tags of its
children, the sealed grants and links, and the metadata, in one transaction, or `rotate_conflict` if anything
has been added since the client read it. A subtree is rotated one node at a time, from the top. A rotation
removes the thumbnail, which has no generation.

**Key generations.** Versions and uploads record the generation of the node key they are sealed under, and
each rotation stores the old key sealed under the new one. That chain comes with a version as `key_chain`, so
old versions read without being sealed again. Every write that seals something can name the generation it
used, checked in its transaction, and a commit is refused if a rotation overtook its upload. Without that, a
client that has not yet seen a rotation would leave a child nobody can open, or new content under a key
someone was meant to lose. These request fields are optional in the schema so that older clients work, and
clients must send them.

**Notifications** are read from `grants`, with a time on the row when its holder marks it, so there is
nothing more to keep in step. A new grant after a revocation is a new row, and notifies again.

**Public links.** A link is owner-made, read-only and covers a subtree. Revoking keeps the row, for the
"shared by me" page, and deleting does not. A link answers `404` if its id is unknown, its owner is disabled
or its node or anything above it is in the trash, and `410` if it has been revoked or has expired.

Anyone reading under a link holds a token signed with a key derived from the server's secret, which says the
link, its node, the session, when the token ends, and when renewing has to stop. Nothing about it is stored.
Each request checks the signature and reads the link again, then requires that the node have the link's node
in its lineage and nothing in its lineage in the trash. A blob must be its node's current version or thumbnail.
These routes are `accessOpen`, so no principal exists on them, and they read no cookie or bearer token.

The download limit counts content when a session first asks for any part of a file, and ranges after that
are free. `link_downloads` makes this one transaction with the count, and a file is opened first, so a missing
file costs nothing. The sweeper forgets claims older than a session can last, which gives nothing back to the
limit. Once it is reached, a new visitor gets `410`. Sessions that have started keep browsing, and finish what
they had claimed.

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

## Single sign-on

**Settings.** In the settings table, changed through `PATCH /admin/settings` or chosen at
setup. The client secret is write-only. Any change needs a current credential, because
whoever names the issuer can sign in as anyone it can match. An issuer is https unless
`allow_insecure` is set, and it is stored as typed, since it has to equal the provider's
spelling. The redirect URI is the public URL plus `/auth/oidc/callback`, never derived from a
request's `Host`. The callback is outside `/api/v1` to be the address that a person registers,
and the Vite dev server needs `/auth` proxied as well as `/api`.

**The flow.** `GET /auth/oidc/start` draws state, nonce and a PKCE verifier and seals them
with AES-GCM into a cookie, under a key derived from the server secret, so that the server keeps
nothing per sign-in and an anonymous flood costs it no memory. The cookie is HttpOnly, has no
Domain, lasts ten minutes and is `__Host-` over HTTPS. It is SameSite=Lax, since a Strict cookie
would not come back with a navigation from another site. The session cookie stays Strict: the
redirect's own document load goes without it, and the app's `fetch` to `GET /me` from that
document is same-site and carries it.

**The callback.** State comes first, so that nobody else's link can say anything to this browser.
Then the code exchange, ID token verification and, for claims the token left out, userinfo. Those
are all done before taking `accountMu`, as a provider may be slow. Any failure redirects to
`/signin?sso_error=<code>` and is audited. Success makes a session and redirects to `/`, with no
token in any URL.

**Finding the account,** under `accountMu`:

1. An account with this exact `(issuer, sub)`.
2. Otherwise, by the match mode, a local account with the verified `email` or the
   `preferred_username`, which must have no identity yet, or the answer is
   `sso_identity_conflict`. A matching address that is not verified is `sso_email_unverified`.
3. Otherwise a new account, if `new_users` is `create`, or with an invite: its token from `POST
   /auth/oidc/start`, or one open for the verified address. The invite is burnt with the account.
   A taken username gets a suffix, and only a verified address is stored.

Nothing moves an account to another identity but `DELETE /admin/users/{id}/identity`.

**Roles.** With `admin_group` set, the claim decides the role at each sign-in, and a missing claim
is not membership. Otherwise sign-in never changes a role. The oldest enabled admin with a
passphrase is the **fallback admin**. They are never demoted, nor is the last admin of any kind.

**Local accounts off.** Local sign-in and registration are refused for all but the fallback admin,
who is the way back in when the provider is down. It is refused with `local_accounts_lockout`
while no provider is on or no local admin exists, and so are turning off the provider or removing
the last local admin while they are off.

**Credentials.** An SSO account has no `auth_key_hash`. Login reads only that and the recovery hash,
so the unlock auth key signs nobody in, and the right recovery key learns `sso_required`. The KDF
route gives such an account's name fake parameters, as `GET /me` has the real ones. In `e2e` mode
`enrolment_required` says it has no keys yet, and `POST /auth/oidc/enrol` stores them once.
After that, rekey with its unlock or recovery auth key replaces them. Recovery is that rekey,
in a session from the provider. In `none` mode it has no credentials at all, so a session under five
minutes old stands in where a current auth key is asked for, `GET /auth/oidc/start?fresh=true` gets
one, and everything else answers `reauth_required`. TOTP answers `totp_local_only` and a reset
link `sso_only`, as either would give a local way in to an account that has none.

## Keeping history bounded

The hourly sweep drops audit entries past `audit_retention_days` (365 by default) and
journal entries past `journal_retention_days` (90), in batches, and zero keeps either
for good. Shortening the audit retention needs a current credential, as a stolen admin
session must not be able to erase its tracks. The journal needs nothing, since losing
it costs a client a read of the tree.

A trim raises `journal_floor` for each user who lost an entry. A cursor below that
floor has missed something, and answers 410 `cursor_expired`: the client reads the tree
again and starts over with no cursor. The floor is per user, so that a quiet user's
cursor does not expire because of everyone else's activity. The route reads the page
before the floor, so a trim racing a read shows as an expiry and never as a silent gap.

`GET /uploads` lists a user's uploads in progress, with how many frames have arrived,
so that one whose id was lost can be resumed or aborted before the sweep drops it.

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

### Drive

`src/lib/drive` is the client of the Drive above. Its modules are pure and take what they
reach outside for, so they run against a fake server in vitest (`src/lib/testing/drive.ts`), and
`src/lib/state/drive.svelte.ts` wires one `Drive` to the session of the app shell. They never read
the mode: everything goes through the `Sealer`, with keys that are empty strings in `none`.

| Where | Holds |
| --- | --- |
| `tree.ts` | Nodes, their opened metadata and their keys, in memory. Everything creates, renames, moves and trashes through here. |
| `upload/` | The frame plan, what survives a reload, one file's upload (`engine.ts`) and the queue. |
| `download/` | Verifying a version, reading it whole, `Range` arithmetic. |
| `stream/` | The service worker's work (`host.ts`) and the page's side of it (`client.ts`). |
| `thumbs/`, `viewers/` | Making and reading thumbnails, and what may be shown in the app. |
| `workers/` | The workers for pages of nodes, frames and thumbnails. |
| `journal.ts`, `versions.ts`, `sort.ts`, `metadata.ts`, `kinds.ts` | What they say. |

**Tree.** Lists come paged by id and are sorted here, which is also the only place they can be. A page
of 64 nodes or more opens in a worker that holds nothing between pages (Spike C). After the root, a walk
reads every folder behind the scenes, breadth first, and that is what fills favorites, recent, tags and
the storage bar. A file with no version has not arrived yet and does not show. Metadata that does not
open shows as an unreadable item and does not spoil the list.

**Tags** live in the metadata of the root, each with an id, a name and a tone, and files hold the ids.
So a tag's page is `/tags/<id>`, as a name must not reach the server in an address.

**Uploads.** A file's node comes first, then the reservation, then the frames, a few at a time, sealed in
a pool of workers that hold the key of this version and never a node key. A digest is written to IndexedDB
before its frame leaves, as the server lists which frames arrived but not their digests, and the content
hash needs them all. After a reload the upload shows as interrupted, and picking the same file (name, size
and date) or dropping it again goes on from what arrived, with the key opened from the tree. The name of
the file comes from its node, so no name is kept on the device. If the server holds a frame this device has no digest
for, or a frame sent before the reload arrives late, the upload starts over, since a frame sealed again has
another nonce. A cancelled or refused first upload trashes and purges its node, which keeps it out of the
trash list and frees the name.

**Reads.** Before any frame, the signature has to verify against the signer and the frame hashes have to add
up to the signed content hash. That ties each hash to the signature, so a frame can be checked and opened on
its own, as seeking needs. The signer has to be the owner or an editor, with their keys checked against the pin;
see Sharing, below. A restored version reads with `content_version_id` and `content_author_id`, and a version under
an older generation with the key its chain reaches.

**Streaming.** In a secure context `src/service-worker.ts` answers `/stream/<id>` and passes everything else by.
A page verifies the version and hands over its one key by transfer. A `Range` maps to frames, each fetched,
checked and opened as the response pulls it, with one frame of read-ahead; an open-ended range gets 16 MiB. The
address holds a random id and the name goes in a header the worker makes, so a name never reaches the server even if
the worker is gone. The worker keeps keys in memory, and loses them on a lock (a page tells it, and it also
listens on the tabs' channel), on sign-out, after ten idle minutes and whenever the browser stops it; it then asks
the open pages again, which answer only while they hold the tree. A stream is served as media, inline, only for an `audio/` or
`video/` type, and as an attachment otherwise, with `nosniff` and a sandboxing CSP.

**Without a service worker**, as over plain HTTP, a download is read into a Blob, up to 1 GiB, with a notice that
says so and an error past the limit that says to use HTTPS. Media loads the same way.

**Thumbnails** are made by the uploader after the commit: images in a worker, video frames in a `<video>`. What
will not decode gets the generic icon. They are sealed under CRYPTO.md section 18 and stored as small blobs. Tampered
with, one just shows the icon.

**Viewers** read the whole file in the frame workers, up to a limit per kind, except media. SVG and HTML, by name or
by type, are only ever downloaded. pdf.js and its worker are built with the app and loaded when a PDF opens, with no
standard fonts, CMaps or wasm decoders embedded, so a PDF relying on those draws with fallbacks or without those images.

**Workers and the CSP.** A worker takes its policy from the response that delivered its script, not from the page, so
`web/embed.go` gives each script under `_app/immutable/workers/` and `service-worker.js` its own: its origin's scripts and
`connect-src 'self'`, nothing else.

**Journal.** Read on focus and once a minute. It starts at the end, since the first read of the tree has it all. Each
changed node is read again, and beyond 100 of them the tree is.

### Sharing

`src/lib/sharing` is the client of the sharing routes, pure like the drive, tested against the fake server with
several people on it, and wired up by `Drive`. `src/lib/state/sharing.svelte.ts` is what the screens see of it.

| Where | Holds |
| --- | --- |
| `contacts.ts` | Pins and safety numbers. A different key from the pinned one throws, and the app shows a warning that takes an answer. |
| `sharing.ts` | Grants, verified before anything of them is used; who may sign what; links; notifications. |
| `rotation.ts` | The body of a rotation, and walking a subtree from a job written down first. |
| `links.ts`, `public.ts` | Making a link, and reading under one with no account. |
| `roles.ts` | What the screens offer. The server decides. |

**In the tree.** A node's key comes from its parent's, or at the top of a share from a verified grant, and the
tree keeps the generation of each. Writes name it and read again on `key_generation_conflict`. A page whose children
do not open sends it back for its folder's key first, as that is what a rotation looks like from a device that has
not heard. An upload the rotation overtakes starts over. What others share stays out of favorites, recent, tags and the
storage bar, and only the owner can star or tag, since those live in the owner's metadata.

**Revoking** writes a job down in `localStorage`, then deletes the grant, then rotates, parents first, noting the
generation each node reached. A job left behind goes on at the next unlock, and a node at the noted generation is done.
A rotation checks the owner's own signature on each grant it seals a new key for. It takes thumbnails away, and the
client that rotated makes them again where the file is at most 128 MiB. Giving up a grant does not rotate: only the
owner can, and nothing tells them to.

**The journal.** `granted`, `role_changed`, `revoked` and `rotated` read the shares again. Then each node is read as
usual, so a `404` drops it and all under it, and a rotated folder reads its children again.

**The public page** runs `bootLink` in place of `boot`: the mode, through the same guard, and no session. It has no
shell, and reads through the frame workers into memory, since streams from the service worker use the session's route.
Nothing is read until someone asks, as a read counts against a download limit.

Browser specs start a throwaway server per file (`web/tests/server.ts`) and drive the wizard
through the app. `YONDRIVE_E2E_BIN` names a binary already built, with the app embedded, when
the working tree does not build.
