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
| Malware on an unlocked device | Yes. |

## What the server still sees

The server sees who the users are, the folder structure as anonymous ids, who shares with
whom, when things change and who is currently editing. It sees exact sizes: nothing is
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
- **Revoking a share is not retroactive.** It stops future access. The node key is rotated
  for future content, and earlier content may have been copied.
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
| **The server hands out a false public key** when you share, and reads everything shared after. | Fingerprints are pinned on first use and a change raises a warning. Two people can compare a safety number over another channel. | First use is trusted unless the number is compared. |
| **Username probing** through the KDF endpoint. | Unknown usernames get stable fake parameters derived from a server secret. | The parameters cannot hide everything. An account with non-default KDF parameters stands out, as fake answers carry the new-account defaults. A real salt changes on rekey and a fake one never does, so watching a username over time can tell them apart. With open sign-up on, registering reveals taken names, within the rate limit. Sign-in timing is not measured. |
| **SSO compromise** gives access to a user's wrapped key, to attack offline. | A minimum passphrase strength, and Argon2id sets the price of each guess. Nothing derived from the unlock passphrase reaches the server. | Weak passphrases can still fall. |
| **Removing someone from a shared folder.** They may have kept the keys. | The node key rotates on revoke, for future content. The app says plainly that earlier content may have been copied. | What they already hold stays readable to them. |
| **A stolen session can delete files.** | Trash, version history and a grace period enforced by the server before anything is purged. | An honest server is assumed for the grace period. |
| **Malicious documents from other users** run in the same origin as the keys. | Parsers run in workers and output a typed model, never HTML. Sanitising, a strict CSP, and SVG and HTML are downloaded rather than rendered inline. | A parser bug that escapes the model. |

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
- **Forged grants.** A grant does not authenticate its sender, and anyone with a public key
  can make one, the server included. A server can present a folder whose key it knows as
  "shared with you", and read what is uploaded there. Sharing must sign grants before it
  relies on them.
- **Metadata authorship.** Metadata is authenticated by the node key, not signed. Anyone with
  read access to a node holds its key, and could write metadata that opens correctly. The
  server refuses the write unless they may edit, so this rests on the server. Content versions
  are signed, metadata is not.
- **Edit rights.** A client verifies a signature against "an author who holds edit rights",
  and the list of who holds them comes from the server. A hostile server can name a viewer as
  an editor, or a user it controls.
- **Key commitment.** XChaCha20-Poly1305 does not commit to a key: someone who knows two keys
  can make one ciphertext that opens under both. Within a signed version, the content hash
  ties the signer to one ciphertext. A signer can still make it open differently for readers
  holding different keys.

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
