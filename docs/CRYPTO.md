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
of the wrong length or under a key of all zeros. Locking overwrites keys with zeros, and
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
4. `auth key = HKDF(root, "yondrive/auth/v1")`, sent to the server, for local accounts
   only. An SSO account MUST NOT derive or send it for the unlock passphrase.

| Parameter | New accounts | Accepted from the server |
| --- | --- | --- |
| `m`, KiB | 65536 | 8192 to 1048576 |
| `t` | 3 | 1 to 10 |
| `p` | 1 | exactly 1 |
| salt | 16 random bytes | exactly 16 bytes |

Stored as `{"name":"argon2id","m":…,"t":…,"p":…,"salt":"<base64>"}`. A client MUST refuse
parameters outside the bounds, and any other `name`.

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

The opened value MUST be 32 bytes.

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

After opening, a client MUST recompute each public key from its private key and refuse a
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

**Root node key,** for the top of a user's tree:

```
Seal(master key, node key, fields("yondrive/node/root/v1", utf8(node id)))
```

**Child node key,** with both ids bound, so moving a node means wrapping it again:

```
Seal(node-wrap subkey of parent, node key,
     fields("yondrive/node/child/v1", utf8(parent id), utf8(node id)))
```

The opened value MUST be 32 bytes.

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
the recipient's own `R`, and open. The opened value MUST be 32 bytes. `e` MUST be zeroed.

A grant does not authenticate its sender.

## 9. Metadata

Metadata is a JSON value (`name`, `type`, dates, tags). Its bytes are its UTF-8 JSON text.

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

Each version has its own key, from the node's content subkey:

```
version key = HKDF(content subkey,
                   fields("yondrive/content/version/v1", utf8(node id), utf8(version id)))
```

### Frames

A version is cut into frames of `frameSize` plaintext bytes. `frameSize` is recorded per
version and MUST be between 1024 and 67108864 bytes. New versions use 4194304 (4 MiB).

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
and `S` not below the group order. A client MUST verify the signature against an author
who holds edit rights, and refuse a manifest whose `frameCount` disagrees with `size` and
`frameSize`, or whose suite differs from the server's. After a full read, it MUST compare
the size and the content hash.

## 13. Suite `none`

The same operations with no keys:

| Operation | Result |
| --- | --- |
| Master key, node key, identity keys, wraps, grants, signature | empty byte strings |
| Metadata | `utf8(json)` |
| Name tag | `SHA-256(fields("yondrive/name/none/v1", utf8(normalized)))`, `normalized` as in section 10 |
| Stored frame | the plaintext frame, unchanged, so a stored version is byte-identical to the file |
| Frame digest, content hash | as in section 11, over the plaintext frames |
| `frameSize`, framing | as in section 11, with an overhead of 0 |

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

A client pins a contact's fingerprint on first use and warns if it changes.

## 16. Labels

| Label | Kind |
| --- | --- |
| `yondrive/kek/v1` | HKDF info, plain |
| `yondrive/auth/v1` | HKDF info, plain |
| `yondrive/node-wrap/v1` | HKDF info, plain |
| `yondrive/meta/v1` | HKDF info, plain |
| `yondrive/name/v1` | HKDF info, plain |
| `yondrive/content/v1` | HKDF info, plain |
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
| `yondrive/meta/seal/v1` | AAD |
| `yondrive/frame/v1` | AAD |
| `yondrive/content/hash/v1` | hash prefix |
| `yondrive/name/none/v1` | hash input |
| `yondrive/version/v1` | signed message |
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
