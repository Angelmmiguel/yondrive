# YonDrive threat model

What end-to-end mode protects, against whom, and where it stops. The constructions are
specified in [CRYPTO.md](CRYPTO.md). The mode is fixed per server at setup. With no
encryption, none of the confidentiality claims below apply: see
[No-encryption mode](#no-encryption-mode).

## Who is protected from whom

| Attacker | Can they read content, names, tags or search terms? |
| --- | --- |
| Someone with a copy of the data directory, database or backup | No. They can attack a passphrase offline, at the Argon2id price per guess. |
| An administrator browsing the server | No. |
| A passive observer of the network, behind TLS | No. Without TLS, they see what the server sees and can do what a hostile server can do. |
| An honest but curious server | No. It sees the metadata listed below. |
| A server that turns hostile while serving the same app | No, within the limits below. |
| A server that replaces the app | **Yes, from the next unlock.** See below. |
| Someone with a grant | Yes, for what was shared. That is the point. |
| Someone with a public link | Yes, for what it covers: the current version of each file and no history. |
| Someone with a public link's id but not its key | No. Without a password on the link, they can fetch ciphertext within its limits. With one, they get nothing until they have it. |
| Malware on an unlocked device | Yes. |

## What the server still sees

The server sees who the users are, the folder structure as anonymous ids, who shares with
whom and in which role, which links exist with their expiry and download count, when things
change and who is currently editing. It sees exact sizes: nothing is
padded, so the plaintext size of each version follows from what is stored, and it is also
in the manifest. It sees the frame digests, the content hash, signatures and public keys.

The name tag shows when two names in one folder are the same, and when a name comes back
after a rename. Without the folder's key it says nothing else.

It cannot see names, types, tags, dates inside metadata, or contents.

## Limits

- **The server delivers the web app.** Someone who takes control of the running server can
  serve a modified app that captures the passphrase at the next unlock. This holds for every
  browser-based end-to-end encrypted service. Reproducible builds and published hashes allow
  checking, and native clients reduce the risk, but none of them remove it for the web app.
  The CSP catches mistakes and injected content. It does not stop a server that writes the CSP.
- **Revoking a share is not retroactive.** It stops future access at once, by the server. The
  client then rotates the node key and those under it, for future content. The rotation seals
  nothing again: existing versions stay under their old keys, which the revoked user may have,
  and earlier content may have been copied. Until each node is rotated, new content in it is
  sealed under a key they may hold.
- **The device is trusted.** Malware on an unlocked device can read what the user can read,
  and capture the passphrase.
- **Zeroing is best effort.** Keys are zeroed on lock and when done with, and all-zero keys
  are refused so that work in flight fails. JavaScript gives no control over copies the
  engine or garbage collector makes, and the crypto library's internal state cannot be
  reached, so this shortens a key's life in memory and does not guarantee its end.
- **Timing is not guaranteed.** The crypto is pure JavaScript, which cannot promise constant
  time. The curve library blinds its secret operations, and comparisons here avoid early exits.
- **A stolen browser profile with a live session opens the account** until the session
  ends: the sealed master key and the cookie that fetches the session key are both in it.
- **Plain HTTP** gives a network attacker the powers of a hostile server. Encryption itself
  still works there, and the app shows a permanent warning.

## Multi-user problems

| Problem | Response | What remains |
| --- | --- | --- |
| **The server hands out a false public key** when you share, and reads everything shared after. | Fingerprints are pinned on first use, per device and sealed under a key from the master key. A change raises a blocking warning, and nothing is shared until someone answers it. A pin holds an account's id and username together, as the server supplies both: a known name on another id, a known id under another name, or an answer to a lookup about anyone but the name asked for stops in the same way, whether it comes from a lookup or a grant. Accepting replaces what the device knew. Two people can compare a safety number over another channel. | First use is trusted unless the number is compared, and a new device is a first use again. A name the device has never seen can look like one it has, so a look-alike is a first use. |
| **Username probing** through the KDF endpoint. | Unknown usernames get stable fake parameters derived from a server secret. | The parameters cannot hide everything. An account with non-default KDF parameters stands out, as fake answers carry the new-account defaults. A real salt changes on rekey and a fake one never does, so watching a username over time can tell them apart. With open sign-up on, registering reveals taken names, within the rate limit. Sign-in timing is not measured. |
| **SSO compromise** gives access to a user's wrapped key, to attack offline. | A minimum passphrase strength, and Argon2id sets the price of each guess. The provider never sees the unlock passphrase, and a session from it cannot replace keys. See [Single sign-on](#single-sign-on). | Weak passphrases can still fall. |
| **Removing someone from a shared folder.** They may have kept the keys. | The node key rotates on revoke, for future content, from the top of the share down. The app says plainly that earlier content may have been copied. | What they already hold stays readable to them. |
| **A false "shared with you".** A server can make a folder whose key it knows and present it as shared, then read what is uploaded there. | Each grant is signed by its granter, over the node, both users, the role, the key generation and the sealed key. A client verifies it against the granter's pinned key, and that the granter owns the node. What does not verify shows as a warning, with no name, and is never opened. | A server can also make an account, and share from it. That shows as a share from someone the user does not know, which is where the safety number matters. |
| **A stolen session can delete files.** | Trash, version history and a grace period enforced by the server before anything is purged. | An honest server is assumed for the grace period. |
| **Malicious documents from other users** run in the same origin as the keys. | Parsers run in workers and output a typed model, never HTML. Sanitising, a strict CSP, and SVG and HTML are downloaded rather than rendered inline, whether the name or the type says so. A service worker stream is never served as anything but media or an attachment. | A parser bug that escapes the model. |

## Single sign-on

With a provider, whoever controls the provider can sign in as anyone it can name. What that
gets them depends on the mode.

**A compromised provider, in `e2e` mode,** gets a session on any account that has an identity,
and on any it can link. That is:

- the wrapped master key and KDF parameters, to attack **offline**. Every guess costs one
  Argon2id run, and the stored hash of the unlock auth key offers nothing cheaper. A strong
  passphrase holds, and a weak one falls. Nothing the provider sees helps, as the passphrase
  is never typed there.
- what any session can do: see the folder structure as anonymous ids, trash files, within
  the grace period, and fill the quota.
- **not** the content, and not the power to replace keys, make a device token or turn off
  anything that needs a current credential.
- for an account with no keys yet, the first enrolment. It can enrol keys of its own, and the
  real user then finds an account that their passphrase does not open and that they did not
  fill. Nothing that was the user's is exposed, as there was nothing there.

**In `none` mode** it reads and changes everything those accounts can reach, as there is no key
between a session and the content.

**Becoming an admin.** With an admin group set, the provider decides who is an admin, at each
sign-in. An admin session sees no content in `e2e` mode, but it can delete users and change
settings, subject to the current credential on the worst of those. The first local admin is
never demoted, and can always sign in with a passphrase, whatever the provider says.

**Linking.** Link modes trust the provider's claims about who someone is. `email` needs
`email_verified` to be true. `preferred_username` trusts a name that many providers let users
choose, so it suits only a provider whose usernames an admin assigns. `sub` links nothing. An
account linked to one identity is never moved to another by signing in: that takes an admin
with a current credential. Linking applies to local admins too, whose account then opens to
the provider, and to the keys only with its passphrase.

**A stolen admin session and the issuer.** Whoever can name the issuer can sign in as anyone it
can match, so changing it, or anything else about sign-in, needs a current credential.

**The second factor** of an SSO sign-in is the provider's. TOTP guards local sign-in alone, so a
local account that is linked and has TOTP on is reached through the provider without it.

**Sessions outlive the provider's word.** Disabling someone at the provider stops their next
sign-in, not a session they have, which lasts up to seven days unless an admin disables them
here. There is no back-channel logout.

**The sign-in itself.** The state, nonce and PKCE verifier are sealed in a short-lived, HttpOnly,
host-only cookie, so that a forged callback or a stolen code goes nowhere. ID tokens are verified
with an allow-list of RS256, ES256 and EdDSA, against keys published by the issuer, which
discovery has to name exactly. The session is a cookie, and no token appears in any URL. The
authorization code does pass through the proxy's logs, which is why it is bound by PKCE and
single use. A sealed flow can be replayed only with a code the provider has not yet used.

**The client secret and the server fetching URLs.** The client secret is stored readable by the
server and is in every backup. It lets someone act as this server toward the provider, and
decrypts nothing. Discovery fetches an address an admin or setup token holder typed, so it uses
bounded requests, follows no redirect to another host, refuses link-local addresses such as a
cloud metadata service, and returns codes rather than what it found. Private addresses stay
allowed, since a provider on the LAN is normal, so an admin can tell which hosts answer.

## What tampering is detected

| Attack on stored data | Result |
| --- | --- |
| Reorder, or swap in frames from another node or version | The frame fails to authenticate. |
| Truncate | A frame's `final` flag no longer matches the signed frame count, or the stream ends early. |
| Extend | Reading past the signed frame count fails. |
| Change frame size or size | The AAD or the signature fails. |
| Swap a wrapped key, grant or metadata onto another node | It fails to authenticate, because ids are bound. |
| Open a wrap for another purpose, such as a session wrap as a passphrase wrap | It fails to authenticate. |
| Pair a sealed private key with another public key | It fails to authenticate, and the public key is recomputed on open. |
| Lower the KDF cost | Refused below `m` = 8192 KiB and `t` = 1. A server can still lower the cost down to that floor, so the floor, not the default, is the guarantee against an active server. |
| Claim mode `none` | Refused by the mode guard, within the limit below. |

**What is not detected:**

- **Rollback.** A server can serve an older version, older metadata or an older wrapped key,
  each still valid. It can also withhold items. Nothing here gives a global view of what is
  current.
- **Withheld revocations.** A server can go on serving a revoked user, or a signed grant that
  has since been revoked, since a signature says only that it was made. A rotation is what stands
  against this, and only for what comes after it.
- **A role.** The signature ties a grant to a role, but the role is enforced by the server. A
  hostile server can let a viewer write. See edit rights, below.
- **Metadata authorship.** Metadata is authenticated by the node key, not signed. Anyone with
  read access to a node holds its key, and could write metadata that opens correctly. The
  server refuses the write unless they may edit, so this rests on the server. Content versions
  are signed, metadata is not.
- **Edit rights.** A client verifies a signature against the author's pinned keys and checks
  that the author holds edit rights, and the list of who holds them comes from the server. To the
  owner it comes with the signed grants, which their client checks with their own key, so a server
  cannot name an editor to the owner. Anyone else has only the list, and a hostile server can name a
  viewer as an editor, or a user it controls. A version whose signer is on no such list opens with a
  warning rather than failing: there is no record of what someone could do when they wrote it, and
  refusing would make every file a former editor uploaded unreadable, to everyone, for good.
- **Key commitment.** XChaCha20-Poly1305 does not commit to a key: someone who knows two keys
  can make one ciphertext that opens under both. Within a signed version, the content hash
  ties the signer to one ciphertext. A signer can still make it open differently for readers
  holding different keys.

## Public links

The key of a link is in the URL's fragment, which browsers do not send, so the server holds only
what it can open. Whoever has the URL has the key. Expiry, revocation and download limits are
enforced by the server, and are as strong as the server is honest.

**A link's password** is checked by the server, in both modes and as at sign-in, against a stored
hash of a key derived from it. A link with a password has no key in its URL, and the wrapped link key
is given only to the right password. So someone with the URL can only guess online, within the limits
per address and per link. **An offline attack needs the server's stored data**, at the Argon2id price
per guess, and a strong password is what protects a link against that. In `e2e` mode the server never
sees anything that opens the wrapped key: the link KEK is a separate derivation and stays on the device.

**Link tokens.** Reading under a link takes a token from `X-Link-Token`, signed by the server and
bound to the link and its node. It lasts 15 minutes and can be renewed for a day. The link's state
is read again on every request, so revoking ends it at once. It is not a cookie, so it cannot be
used across sites, and the routes under a link read neither cookies nor bearer tokens, so being
signed in reaches nothing there. A link token opens nothing else. It reaches a node's current version and
thumbnail at or under the link's node, and neither the trash, nor older versions, nor anything
above it. `Referrer-Policy: no-referrer` is on every response, so a link's path does not leave
through a referrer.

**What a link shows.** No owner, username or quota. A reader sees the Ed25519 public key of a
version's signer, which it needs to verify the signature, and that key is the same across links.
It verifies only that the key signed, since a reader with no account has nothing to pin it against:
a server can substitute content with a key of its own. If the signer's account has gone there is no
key, and a reader with keys refuses the file.

**The reader's page.** The key is read out of the fragment and taken out of the address at once, so
reloading needs the whole link again. It stays in memory. The page asks nothing about a session, even
in a browser that has one. Reads go through `fetch` with the token in a header, and what is read is held
in memory, up to 1 GiB, as the service worker's streams use the session's route.

**Download limits** count a file once per session, at its first byte, in a transaction, so that they
hold under any concurrency. A file started and abandoned has counted. The count is not a statement
about what anyone received, and a session already reading a file finishes it.

## Downgrade

A hostile server could claim to be in `none` mode so that clients upload plaintext. The mode is
written once at setup, with no route to change it. A client that finds wrapped keys for the
account refuses `none`, each device pins the first mode it saw and stops on a change, and the
manifest's suite is signed and checked per item.

**The limit:** a new device, signing in to an account whose server hides its wrapped keys and
claims `none`, has nothing to compare against and accepts. And in the web app, this catches
mistakes and migrations but not a server that also replaces the JavaScript. Native clients do
not load code from the server, so the check is stronger there. The app shows a permanent "Not
encrypted" indicator in `none` mode.

## No-encryption mode

Files are stored as they are, and metadata as readable JSON. Anyone with the server or its disks
reads everything. There are no keys, recovery keys, pinning or signatures, and an administrator
can reset a password. The per-frame SHA-256 detects disk corruption, and is not protection against
anyone who can write to the disk. Use disk encryption such as LUKS or ZFS native encryption against
theft of the disks.

## Implementation safeguards

- `@noble/*` and `@scure/*` are pinned to exact versions, installed with `--frozen-lockfile`,
  with install scripts disabled and a minimum release age. They are pure JavaScript, so they work
  over plain HTTP and need no CSP change for WebAssembly.
- Randomness comes only from `crypto.getRandomValues`, with no fallback.
- Argon2id runs in a one-shot worker, terminated as soon as it answers.
- Usable keys exist only in memory. Only ciphertext whose key is elsewhere touches the disk.
- RFC known-answer tests cover each primitive. `crypto-vectors.json` is produced separately
  from the client code and checked against it.
