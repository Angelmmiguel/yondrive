# YonDrive cryptography

This is the normative specification of the client cryptography. It is independent of
any language: a client that implements this document and passes
[`crypto-vectors.json`](crypto-vectors.json) interoperates with every other client. The
threat model is in [SECURITY.md](SECURITY.md).

Keywords: MUST and MUST NOT are requirements. The label `v1` in a string belongs to the
construction, and a change to a construction means a new label.

## 1. Conventions

All integers are unsigned big-endian. `u32(n)` is 4 bytes, `u64(n)` is 8 bytes. `||` is
concatenation. `utf8(s)` is the UTF-8 encoding of `s`.

**Keys** are 32 bytes. An implementation MUST refuse to seal, open or derive under a key
of the wrong length or under a key of all zeros, and MUST refuse to wrap or seal such a key. Locking overwrites keys with zeros, and
anyone can forge a message under the all-zero key.

**Randomness** comes only from the platform's cryptographic source (in a browser,
`crypto.getRandomValues`). There is no fallback.

**Field encoding.** Every AAD, signed message and labelled hash in this document uses
one framing, so two different lists of fields cannot produce the same bytes:

```
LP(x)                 = u32(length of x) || x
fields(label, f1..fn) = LP(utf8(label)) || LP(f1) || ... || LP(fn)
```

**Ids.** A node or version id is an opaque non-empty string, bound as `utf8(id)`, exactly
as the API spells it. An implementation MUST refuse an empty id. Ids are known before
sealing, since they enter the AAD.
The API spells a node, version or small blob id as 32 lowercase hex characters from 16
random bytes, chosen by the client, and refuses any other form or an id already in use.

**HKDF** is HKDF-SHA256 (RFC 5869) with no salt (that is, `HashLen` zero bytes) and
`L = 32`, written `HKDF(key, info)`. `info` is either `utf8(label)` for a plain label, or
a `fields(...)` value where this document shows one.

**Sealing.** `Seal(key, plaintext, aad)` is XChaCha20-Poly1305
(draft-irtf-cfrg-xchacha-03) under a fresh random nonce, with this wire format:

```
offset  size  field
0       1     version, 0x01
1       24    nonce, random
25      n     ciphertext
25+n    16    Poly1305 tag
```

The overhead is 41 bytes. `Open` MUST check, in this order: key usable, length at least
41, version byte is `0x01`, then the tag. Failure reveals nothing else.

**Transport.** Binary values cross the API as padded standard base64, parsed strictly.

## 2. Suites

A suite names how an item is protected. It is recorded on every item.

| Suite | Meaning |
| --- | --- |
| `xchacha20poly1305-v1` | End-to-end mode. Everything in sections 3 to 12. |
| `none` | No encryption. See section 13. |

A client MUST refuse any other value, and an item whose suite differs from the server's.

## 3. Passphrase to keys

1. Normalise the passphrase to NFKC. Its length in code points MUST be between 12 and
   1024.
2. `root = Argon2id(utf8(normalized), salt, m, t, p, tag length 32)` (RFC 9106), with no
   secret and no associated data.
3. `KEK = HKDF(root, "yondrive/kek/v1")`, which never leaves the device.
4. `auth key = HKDF(root, "yondrive/auth/v1")`, sent to the server. A local account signs
   in with it. An SSO account derives it from its unlock passphrase in the same way, and
   MUST send it only to prove a current credential, never to sign in.

| Parameter | New accounts | Accepted from the server |
| --- | --- | --- |
| `m`, KiB | 65536 | 8192 to 1048576 |
| `t` | 3 | 1 to 10 |
| `p` | 1 | exactly 1 |
| salt | 16 random bytes | exactly 16 bytes |

Stored as `{"name":"argon2id","m":…,"t":…,"p":…,"salt":"<base64>"}`. A client MUST refuse
parameters outside the bounds, and any other `name`.

### SSO accounts

An account that signs in through an identity provider has a separate unlock passphrase
(PLAN.md, D2), and runs the same derivation with it. The provider's word gives a session.
It opens nothing, and it must not be enough to replace keys, or a compromised provider
could lock a user out of their data or plant keys of its own. So those actions need
something the provider never sees: a **current credential**, which is either the unlock
auth key or the recovery auth key. It is asked for when rekeying, making a device token,
changing TOTP and for the admin actions that need one, as for a local account.

The unlock auth key is sent for those actions alone, and never at sign-in. The server stores
its SHA-256 in `unlock_auth_key_hash`, a column the sign-in route does not read, so it signs
nobody in even by mistake.

This costs nothing against the keys. HKDF is one-way, so the server that receives the auth
key learns nothing about the KEK, as with a local account. The stored hash gives someone with
the database a way to test a guess at the Argon2id price, which the wrapped master key gives
them already.

**Enrolment.** A new SSO account in `e2e` mode has no keys. Its client draws the master key,
identity keys and recovery key, and stores them with `POST /auth/oidc/enrol`, which works once
on the strength of the session, when there is nothing yet to protect. Replacing them after
that takes `POST /auth/rekey` with a current credential. Recovery works as for a local account,
but in a session from the provider, since the recovery auth key does not sign an SSO account in.

In mode `none` an SSO account has no passphrase and no recovery key, and no enrolment. A sign-in
through the provider in the last five minutes stands in for a current credential.

## 4. Recovery key

32 random bytes, shown once as 24 English BIP39 words. BIP39 is only a checksummed
encoding: no seed is ever derived from the phrase. On input, surrounding and repeated
whitespace and letter case are ignored; everything else must be exact.

`recovery KEK = HKDF(recovery key, "yondrive/kek/v1")` and
`recovery auth key = HKDF(recovery key, "yondrive/auth/v1")`. No Argon2id: the key is
uniformly random.

## 5. Master key

32 random bytes per user. `wrapped = Seal(wrapping key, master key, aad)`:

| Wrapped under | AAD |
| --- | --- |
| KEK | `fields("yondrive/master/passphrase/v1")` |
| recovery KEK | `fields("yondrive/master/recovery/v1")` |
| session key | `fields("yondrive/master/session/v1")` |

The opened value MUST be 32 bytes and not all zeros.

**Session key.** To survive a reload, the client draws a random 32-byte session key, gives
it to the server, which holds it in memory on the session, and keeps the wrapped master
key in `sessionStorage`. Neither half opens anything alone. Lock, logout and expiry
delete the server half.

## 6. Identity keys

Each user has an X25519 keypair (RFC 7748) and an Ed25519 keypair (RFC 8032), whose
private keys are 32 random bytes. The server stores both public keys and:

```
sealed X25519  = Seal(master key, X25519 private,  fields("yondrive/identity/x25519/v1", X25519 public))
sealed Ed25519 = Seal(master key, Ed25519 private, fields("yondrive/identity/ed25519/v1", Ed25519 public))
```

An opened private key MUST be 32 bytes and not all zeros. After opening, a client MUST recompute each public key from its private key and refuse a
mismatch.

## 7. Node keys

A node is a file or folder, with a key of 32 random bytes. The node key is only ever HKDF
input, or a wrapped value; it is never a cipher key itself.

| Subkey | Derivation | Use |
| --- | --- | --- |
| node-wrap | `HKDF(node key, "yondrive/node-wrap/v1")` | wraps child node keys |
| meta | `HKDF(node key, "yondrive/meta/v1")` | seals this node's metadata |
| name | `HKDF(node key, "yondrive/name/v1")` | tags the names of this folder's children |
| content | `HKDF(node key, "yondrive/content/v1")` | derives version keys |
| previous | `HKDF(node key, "yondrive/node-previous/v1")` | seals the key this one replaced |

**Root node key,** for the top of a user's tree:

```
Seal(master key, node key, fields("yondrive/node/root/v1", utf8(node id)))
```

**Child node key,** with both ids bound, so moving a node means wrapping it again:

```
Seal(node-wrap subkey of parent, node key,
     fields("yondrive/node/child/v1", utf8(parent id), utf8(node id)))
```

The opened value MUST be 32 bytes and not all zeros.

## 8. Grants

A grant seals a node key to a user's X25519 public key `R`:

```
e, E       = fresh ephemeral X25519 keypair
shared     = X25519(e, R)               refuse if all zeros (low-order R)
wrap key   = HKDF(shared, fields("yondrive/grant/key/v1", E, R))
aad        = fields("yondrive/node/grant/v1", E, R, utf8(node id))
grant      = E || Seal(wrap key, node key, aad)
```

The grant is 105 bytes for a 32-byte node key. To open, split off the first 32 bytes as
`E`, compute `shared = X25519(r, E)`, refuse all zeros, derive the same `wrap key` and `aad` using
the recipient's own `R`, and open. The opened value MUST be 32 bytes and not all zeros. `e` MUST be zeroed.

### Signature

The grant itself does not authenticate its sender, and anyone with a public key can make
one, so the granter signs it:

```
message   = fields("yondrive/grant/v1", utf8(node id), utf8(granter id), utf8(grantee id),
                   utf8(role), u32(key generation), grant)
signature = Ed25519-Sign(granter's Ed25519 private key, message)
```

`role` is `viewer` or `editor`, and the key generation is the one of the sealed key. Changing
a role or rotating the key signs again. Verification follows section 12. A grantee MUST verify
the signature with the granter's pinned key (section 15), and MUST check that the granter is
the node's owner, before using the grant or showing the node as shared with them. The server
checks the size alone: 105 bytes for the grant and 64 for the signature. Before a rotation seals a
new key to a grantee, the owner MUST verify that grant with their own key, as the list of grants
comes from the server.

### Rotation

A node key has a generation, which starts at 1. Rotating replaces the key with a new random
one and adds 1. It takes one call, `POST /nodes/{id}/rotate`, made by the owner, whose whole
body is applied in one transaction:

| Field | Value |
| --- | --- |
| `key_generation` | the node's current generation |
| `parent_key_generation` | the parent's current generation |
| `wrapped_key` | the new key, wrapped as in section 7, under the parent's key |
| `previous_key` | `Seal(previous subkey of the new key, old key, fields("yondrive/node/previous/v1", utf8(node id), u32(old generation)))` |
| `sealed_metadata` | the node's metadata, sealed as in section 9 under the new key |
| `children` | every direct child, trashed ones too: `id`, its own unchanged key wrapped as in section 7 under the new key, and its name tag remade as in section 10 under the new key |
| `grants` | every grant on the node: `grantee_id`, a new grant (section 8) of the new key, and a signature over the new generation |
| `links` | every live link on the node: `id`, and a new `sealed_key` (section 19) of the new key |

Anything else about the node stays: its versions and their frames are not sealed again.

**Reading older versions.** A version records the `key_generation` it was sealed under, and
section 11 uses the node key of that generation. The API gives a version its `key_chain`: the
`previous_key` of each generation from the current one back to the version's, newest first.
To reach an old key, start from the current key and open each link with the `previous` subkey
of the key before it, checking the node id and generation in the AAD. A key opens every older
one and no newer one, so someone holding an old key learns nothing from a rotation, and a new
grantee can read the history of what is shared with them.

**Writes.** A client MUST send the generation it sealed under: `parent_key_generation` with a
new node, a move and a rename, `key_generation` with new metadata and a new upload. The server
answers `key_generation_conflict` if it has moved on, and the client reads the node again and
seals again. An upload that is overtaken by a rotation is refused at commit, and starts over.
A client without the generation of a thumbnail that fails to open MUST treat it as missing:
rotating removes the thumbnail, and it can make another.

**Revoking from a subtree.** The grant covers the subtree, and the revoked user may have kept
every key in it. After revoking, the owner's client rotates the node of the grant and then each
node under it, parents first, so that each `wrapped_key` is made under the parent's new key.
Each rotation stands alone, and a node's generation shows whether it has been done, so a client
that stops can resume. Grants above the node keep working, as the node's new key is wrapped
under its parent. A `rotate_conflict` means that someone has just added a child, grant or link:
read them again and seal again. A holder who gives up a grant may have kept the keys as well, so an
owner's client treats a `revoked` row in its journal with no `rotated` row after it, for a node it
owns, in the same way.

## 9. Metadata

Metadata is a JSON value. Its bytes are its UTF-8 JSON text. On a file or folder it has
`name`, `type` (a media type, as the browser reported it), `created` and `modified` (Unix
milliseconds), `size` (plaintext bytes), `tags` (tag ids) and `favorite`. On a root it has
`tags`, the user's list of tags: `id`, `name` and `tone`. A client MUST keep fields it does
not know when it rewrites metadata, and treat what is missing as empty.

```
Seal(meta subkey, utf8(json), fields("yondrive/meta/seal/v1", utf8(node id)))
```

## 10. Name tag

The tag lets the server reject a duplicate name in a folder without learning the name.

```
normalized = NFC(lower(NFC(name)))
tag        = HMAC-SHA256(name subkey of the parent folder, utf8(normalized))
```

`lower` is the Unicode default `toLowercase` conversion (The Unicode Standard, section
3.13, full mappings from `SpecialCasing.txt`), with no locale tailoring. So `İ` (U+0130)
becomes `i` + U+0307, a capital sigma at the end of a word becomes `ς` (U+03C2), and
`ß` is unchanged. Names are not trimmed, and compatibility forms such as `ﬁ` (U+FB01) stay
distinct, since NFC leaves them alone.

The tag is an aid against accidental duplicates, not a security boundary. Clients on
different Unicode versions can disagree about characters one of them does not know.

## 11. Content

### Version key

Each version has its own key, from the content subkey of the node key of the generation the
version records (section 8):

```
version key = HKDF(content subkey,
                   fields("yondrive/content/version/v1", utf8(node id), utf8(version id)))
```

### Frames

A version is cut into frames of `frameSize` plaintext bytes. `frameSize` is recorded per
version and MUST be between 1024 and 67108864 bytes. New versions use 4194304 (4 MiB).
A YonDrive server takes frames of up to 16777216 bytes (16 MiB).

Each file has exactly one framing:

- `frameCount = max(1, ceil(size / frameSize))`.
- Every frame but the last holds exactly `frameSize` bytes.
- The last frame holds 1 to `frameSize` bytes; it holds 0 bytes only if it is the only
  one. An empty file therefore has one frame, so removing every frame is detectable.
- Index `i` runs from 0, and `final` is 1 only on the last frame.

```
aad    = fields("yondrive/frame/v1", utf8(node id), utf8(version id),
                u32(frameSize), u32(index), final as a single byte 0x00 or 0x01)
stored = Seal(version key, frame plaintext, aad)
```

Frames are stored consecutively with no other header. Frame `i` starts at byte
`i * (frameSize + 41)`.

A reader MUST refuse a stored frame whose implied plaintext length breaks the framing. It
MUST derive `final` from the manifest's frame count rather than accept it from the server.
A sequential reader MUST fail if frames stop before the last one or continue after it.
Decrypted plaintext of a frame that does not authenticate MUST NOT be released.

### Frame digest and content hash

Beside each stored frame the server keeps `sha256 = SHA-256(stored)`. A client checks it
before opening, and it lets the frame be scrubbed for corruption without keys.

```
content hash = SHA-256(fields("yondrive/content/hash/v1") || sha256(frame 0) || ... || sha256(frame n-1))
```

## 12. Version manifest

| Field | Type |
| --- | --- |
| `nodeId`, `versionId` | id |
| `suite` | string |
| `size` | plaintext bytes |
| `frameSize`, `frameCount` | integers |
| `contentHash` | 32 bytes |

```
message   = fields("yondrive/version/v1", utf8(node id), utf8(version id), utf8(suite),
                   u64(size), u32(frameSize), u32(frameCount), content hash)
signature = Ed25519-Sign(author's Ed25519 private key, message)
```

Verification follows RFC 8032 strictly: it MUST refuse non-canonical `R` and `A` encodings
and `S` not below the group order. A client MUST verify the signature against the author's
pinned keys, and check that the author is the owner or an editor of the node. An author who is
neither has lost the right since, or the server is lying: a client MUST NOT present that version
as written by someone who may edit, and says so to the reader. It MUST refuse a manifest whose `frameCount` disagrees with `size` and
`frameSize`, or whose suite differs from the server's. After a full read, it MUST compare
the size and the content hash.

The manifest travels as UTF-8 JSON with these fields, `contentHash` in the base64 of section 1.
The server keeps it as sent and reads nothing in it. A reader MUST check its `nodeId` and
`versionId` against the version it asked for, and its `contentHash` against the frame hashes
the API gives with the version, which ties each hash to the signature, so a single frame can
be checked on its own.

Restoring a version makes a new version over the same stored frames, without touching them.
Those frames stay sealed and signed under the id they were written with, so the API gives
each version a `content_version_id` and a `content_author_id` next to its `id` and author.
A reader MUST use `content_version_id` as the version id in the version key, the frame AAD
and the manifest, and verify the signature against `content_author_id`. The two differ from
the version's own id and author only on a restored version.

## 13. Suite `none`

The same operations with no keys:

| Operation | Result |
| --- | --- |
| Master key, node key, link key, identity keys, wraps, grants, signatures, previous keys, sealed link keys, fingerprints | empty byte strings |
| Pins | none: there is nothing to pin |
| Link password | section 19 |
| Metadata | `utf8(json)` |
| Name tag | `SHA-256(fields("yondrive/name/none/v1", utf8(normalized)))`, `normalized` as in section 10 |
| Stored frame | the plaintext frame, unchanged, so a stored version is byte-identical to the file |
| Frame digest, content hash | as in section 11, over the plaintext frames |
| `frameSize`, framing | as in section 11, with an overhead of 0 |
| Thumbnail, index segment | the bytes, unchanged |

## 14. Mode guard

The account has keys if any of its key material is non-empty: either wrapped master key,
either sealed private key, or either public key. The client refuses mode `none` if the
account has keys, or if the device pinned `xchacha20poly1305-v1`. The answer MUST NOT depend
on the claimed suite's own code path.

| Server claims | Account has wrapped keys | Device pin | Result |
| --- | --- | --- | --- |
| `none` | yes | any | refuse (`account-has-keys`) |
| `none` | no | end-to-end | refuse (`device-pinned`) |
| `none` | no | `none` or nothing | accept |
| end-to-end | any | `none` | refuse (`device-pinned`) |
| end-to-end | any | end-to-end or nothing | accept |
| anything else | any | any | refuse (`unknown-suite`) |

On acceptance, a device with no pin stores the suite.

## 15. Key pinning

```
fingerprint   = SHA-256(fields("yondrive/fingerprint/v1", X25519 public, Ed25519 public))
digest        = SHA-512(fields("yondrive/safety-number/v1", low, high))
```

`low` and `high` are the two users' fingerprints in bytewise order, so the result does not
depend on who computes it. Each of the twelve groups reads the next 5 bytes of `digest` as
an integer, takes it modulo 100000, and prints it as five decimal digits with leading
zeros. Groups are separated by one space. Bytes 60 to 63 are unused.

A client pins a contact's fingerprint on first use, with their user id and username, and warns if
the fingerprint changes, if a pinned username comes back on another id, or if a pinned id comes back
under another username. Usernames compare trimmed and in lower case, as the server stores them. The
pins stay on the device, and they are sealed there, so that nothing else can write one and a stolen
profile does not list whom someone shares with:

```
pins key = HKDF(master key, "yondrive/pins/v1")
stored   = Seal(pins key, pins, fields("yondrive/pins/seal/v1", utf8(user id)))
```

The bytes of `pins` are the device's own business, and no other client reads them.

## 16. Labels

| Label | Kind |
| --- | --- |
| `yondrive/kek/v1` | HKDF info, plain |
| `yondrive/auth/v1` | HKDF info, plain |
| `yondrive/node-wrap/v1` | HKDF info, plain |
| `yondrive/meta/v1` | HKDF info, plain |
| `yondrive/name/v1` | HKDF info, plain |
| `yondrive/content/v1` | HKDF info, plain |
| `yondrive/thumb/v1` | HKDF info, plain |
| `yondrive/index/v1` | HKDF info, plain |
| `yondrive/node-previous/v1` | HKDF info, plain |
| `yondrive/link-wrap/v1` | HKDF info, plain |
| `yondrive/link-kek/v1` | HKDF info, plain |
| `yondrive/link-auth/v1` | HKDF info, plain |
| `yondrive/link-owner/v1` | HKDF info, plain |
| `yondrive/pins/v1` | HKDF info, plain |
| `yondrive/content/version/v1` | HKDF info, fields |
| `yondrive/grant/key/v1` | HKDF info, fields |
| `yondrive/master/passphrase/v1` | AAD |
| `yondrive/master/recovery/v1` | AAD |
| `yondrive/master/session/v1` | AAD |
| `yondrive/identity/x25519/v1` | AAD |
| `yondrive/identity/ed25519/v1` | AAD |
| `yondrive/node/root/v1` | AAD |
| `yondrive/node/child/v1` | AAD |
| `yondrive/node/grant/v1` | AAD |
| `yondrive/node/previous/v1` | AAD |
| `yondrive/link/key/v1` | AAD |
| `yondrive/link/password/v1` | AAD |
| `yondrive/link/owner/v1` | AAD |
| `yondrive/pins/seal/v1` | AAD |
| `yondrive/meta/seal/v1` | AAD |
| `yondrive/frame/v1` | AAD |
| `yondrive/blob/thumb/v1` | AAD |
| `yondrive/blob/index/v1` | AAD |
| `yondrive/content/hash/v1` | hash prefix |
| `yondrive/name/none/v1` | hash input |
| `yondrive/version/v1` | signed message |
| `yondrive/grant/v1` | signed message |
| `yondrive/fingerprint/v1` | hash input |
| `yondrive/safety-number/v1` | hash input |

## 17. Test vectors

[`crypto-vectors.json`](crypto-vectors.json) has fixed inputs and expected outputs for every
construction above, with nonces and ephemeral keys included so that sealing can be compared
byte for byte. `web/scripts/crypto-vectors.mjs` produces it from this document on
`node:crypto`, separately from the client code (Argon2id excepted, which that runtime
lacks), and `web/src/lib/crypto/vectors.test.ts` checks the client code against the file.

Adding a vector is fine. Changing an expected output means changing the format, which needs
a new label.

## 18. Thumbnails and index segments

These are stored whole, in one blob under an id the client chooses. A client can make them
again, so they have no frames and no signature. Each is bound to the id of its blob, so the
server cannot serve one in place of another.

```
thumbnail key = HKDF(node key, "yondrive/thumb/v1")
stored        = Seal(thumbnail key, image bytes, fields("yondrive/blob/thumb/v1", utf8(node id), utf8(blob id)))

index key     = HKDF(master key, "yondrive/index/v1")
stored        = Seal(index key, segment bytes, fields("yondrive/blob/index/v1", utf8(blob id)))
```

The index key is what the worker that holds the index gets, so it never holds the master key.
A segment is UTF-8 JSON, `{"v":1,"seq":…,"docs":[…],"gone":[…],"terms":{…}}`: the documents it
holds, the ids it removes, and for each word a list of `document index << 2 | field`, where field
0 is the name, 1 a tag and 2 the text. A higher `seq` wins for any id. Clients make and merge
segments as they like, so nothing else about them is fixed.

A thumbnail is an image in a format every browser decodes, JPEG or WebP, whatever the file was.
A client MUST draw it as an image and nothing else, since the server chooses which bytes it gets.

## 19. Public links

A link's id is 32 lowercase hex characters from 16 random bytes, chosen by the client. Its
key is 32 random bytes, which the server never sees. It reads the same as a grant: only what
the node's key opens, and down from it through the wraps of section 7.

```
sealed key  = Seal(HKDF(link key, "yondrive/link-wrap/v1"), node key,
                   fields("yondrive/link/key/v1", utf8(link id), utf8(node id)))
owner copy  = Seal(HKDF(master key, "yondrive/link-owner/v1"), link key,
                   fields("yondrive/link/owner/v1", utf8(link id)))
```

The owner's copy lets a rotation seal the new node key for the link, and lets the app show the
URL again. Both are 73 bytes.

**No password.** The URL is `https://host/s/<id>#<link key>`, the key in unpadded base64url.
Browsers do not send a fragment to a server.

**A password,** with the Argon2id of section 3 and its bounds, under a fresh salt. The URL is
`https://host/s/<id>`, with no key in it.

```
root         = Argon2id(utf8(NFKC(password)), salt, m, t, p, tag length 32)
auth key     = HKDF(root, "yondrive/link-auth/v1")
link KEK     = HKDF(root, "yondrive/link-kek/v1")
wrapped key  = Seal(link KEK, link key, fields("yondrive/link/password/v1", utf8(link id)))
```

A reader gets the KDF parameters from the link, derives the root and sends the auth key to
`POST /public/links/{id}/unlock`. The server stores its SHA-256 and compares in constant time, and
only then answers with the wrapped key, the sealed key and a token. The reader opens the wrapped
key with the link KEK, which never leaves the device: HKDF is one-way, so the auth key says nothing
about it.

**Suite `none`.** There is no link key and no wrapped key, and the URL has no key. A password makes
the same auth key, sent to the same route.

An opened link key or node key MUST be 32 bytes and not all zeros.
