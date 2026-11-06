# Spike C: scale

Question: do client-side listing and search hold up at 100,000 nodes with sealed metadata (PLAN 5.2, 5.5)?

## What was tested

- 100,000 synthetic nodes. Each holds one sealed metadata blob (name, type, mtime, size, tags as JSON, XChaCha20-Poly1305
  with a 24-byte nonce; average 146 bytes), a parent id and a 32-byte name HMAC, in one IndexedDB object store.
- Measured in headless Chromium 156 and Firefox 157, on the main thread, two runs each (the table shows Chromium run 1 and
  the Firefox range). Desktop hardware; no phone.
- Search: lowercase tokens of the names into a `Map` of token to node indexes, with a sorted vocabulary and a binary
  search for prefix queries. The names use a small word list plus a number unique to each node, so the vocabulary
  (100,046 tokens) is larger than a real library's: a pessimistic case for the index.
- File contents were not indexed (only names), so the index is smaller than the real one will be.

## Numbers

| Step | Chromium | Firefox |
| --- | --- | --- |
| Write 100k rows to IndexedDB (one transaction) | 2.1 s | 3.9 to 4.0 s |
| IndexedDB size | about 30 MB (estimate; sealed data is 13.9 MB) | about 69 MB (estimate) |
| Read all 100k rows (`getAll`) | 0.75 s | 0.5 to 0.65 s |
| Read one page of 200 rows | 58 ms | 13 to 14 ms |
| Decrypt all 100k metadata blobs | 1.0 to 1.2 s (10 to 12 us per node) | 1.7 to 2.2 s |
| Decrypt a page of 200 | 2 ms | 3 ms |
| Sort 100k by name after decrypt | 75 ms | about 195 ms |
| Build the inverted index | 85 to 105 ms | 120 to 127 ms |
| Prefix search (most queries) | 0.2 to 0.6 ms | 0.2 to 0.6 ms |
| Worst prefix (`m`, 46k hits) | 2.1 ms | 3.3 ms |
| Serialised index | 3.9 MB, 28 ms to parse | 3.9 MB, 30 ms |
| JS heap after all of it (Chromium) | 159 MB | not available |

Cold unlock-to-usable with everything loaded eagerly is therefore about 2 s in Chromium (read 0.75 + decrypt 1.1 +
index 0.1) and about 3 s in Firefox on a desktop. The IndexedDB size estimates are approximate and differ by engine; they
are the same order as the data.

## What could not be tested

- Phones and slower machines. Extrapolation, labelled as an assumption: with 2 to 4 times slower cores, eager unlock would
  be 4 to 12 s.
- Real directory trees (the nodes had 500 parents, not a realistic shape), real filenames, and text content in the index.
- Decrypting in workers; the numbers are main-thread, so a worker would also keep the UI responsive.
- WebKit (does not start in this environment).
- Incremental updates and segment compaction.

## What it means for the design

- **The numbers pass at 100k nodes**: search is far below any interaction threshold, and the whole metadata set decrypts in
  1 to 2 s on a desktop.
- **Do not decrypt eagerly on the critical path.** Page listings by id (a folder view of 200 rows is 2 to 3 ms to decrypt,
  plus the read), and decrypt the rest lazily in a worker after unlock. A folder is usable immediately; the global index
  and sort order for very large folders fill in as decrypting proceeds.
- **Read with a cursor or bounded `getAll`** for a visible page rather than the whole store; reading everything is the
  larger of the fixed costs in Chromium.
- **Persist the index**, not just the nodes: loading the serialised index (about 30 ms) is much cheaper than rebuilding it
  from decrypted names once content text is included. Keep it in per-user segments as planned; the prefix search over a
  sorted vocabulary needs no further structure at this scale.
- **Write in batches** at first sync (2 to 4 s for 100k rows in one transaction): show progress and keep the list usable.
- Do the heavy work in a worker so the 1 to 2 s of decryption does not block the page; this is the main reason to leave
  lazy decryption in the design.
- No plan change is needed. PLAN 5.2 ("paged by id and sorted after decryption") holds, with the addition that sorting a
  fully decrypted 100k set takes under 0.2 s.
