# Changelog

What each release ships, by area, and what it does not yet do. The release
workflow publishes the section of a version as its release notes, and refuses a
tag whose section is missing or still marked unreleased
([docs/RELEASE.md](docs/RELEASE.md)).

## [Unreleased]

### Sharing

- File requests: "Request files" in the share dialog of a folder you own makes a
  link that lets anyone, with no account, send files into the folder without
  seeing what is in it, what they sent included. It can have a password, an
  expiry, a largest file, a number of files and a total size, each stopping an
  upload with its own error code, and the files count against your quota. A new
  request suggests a total of 1 GB; with no total and no quota there is no bound.
  An upload that receives nothing for an hour is dropped, so nobody holds a
  request's places for long. A folder with a live request says "Requesting
  files".
- In end-to-end mode each file is encrypted in the sender's browser under a key
  of its own, sealed to the request's public key, which the link carries after
  the `#`. A server that names another key is refused, and so is one that claims
  not to encrypt for an address that carries a key. The request's private key is
  bound to its folder, so what arrives cannot be moved into another. The format
  is section 20 of [docs/CRYPTO.md](docs/CRYPTO.md), with test vectors.
- What arrives waits outside your files until the app adopts it into the folder,
  each time it opens, with a notification and a count. A clash takes the next
  free name. What could not be added is listed under "Shared by me", to try
  again or delete, and what an ended request never saw adopted is purged after
  the grace period.
- The sender may add a name and a message, sealed with each file. The page
  clears its list once everything is sent, and keeps nothing on the device.

### Server

- Schema version 8: `links` gains a kind and a request's limits, and a new
  `incoming` table holds what waits to be adopted. Upgrading migrates in place.
- New routes under `/api/v1/public/requests/{id}` and `/api/v1/incoming`, and
  the codes `request_file_too_large`, `request_files_reached` and
  `request_bytes_reached`. The server chooses the ids of what is sent. On
  `Link`, `kind` and `uploads_in_progress` are new and `role` is absent on a
  request.

## [1.0.0] - 2026-11-07

The first release: a private drive with documents, spreadsheets, notes and
sharing, in one binary and one data directory, with end-to-end encryption by
default. Earlier milestones (0.1 to 0.6 in [PLAN.md](PLAN.md)) were never
published, so everything below is new.

### Encryption and accounts

- Two encryption modes, chosen once at setup for the whole server: end-to-end
  (the default), where the server holds only ciphertext and never sees names,
  tags, contents or search terms, and no encryption, where files are stored as
  they are and everything else works the same.
- Argon2id, XChaCha20-Poly1305, X25519 and Ed25519 in the browser, through the
  audited `@noble` libraries. The format is specified independently of the code
  in [docs/CRYPTO.md](docs/CRYPTO.md), with test vectors for other clients.
- A 24-word recovery key per user, generated on the device and confirmed by
  typing words back. Recovery with it alone after a lost passphrase.
- Setup wizard behind a one-time token printed to the logs. Invitations and open
  sign-up, local accounts with one passphrase, TOTP with recovery codes, and
  single sign-on through OpenID Connect (guides for Pocket ID, Authelia,
  Authentik and Keycloak), with a separate unlock passphrase in end-to-end mode.
- Bearer tokens for devices, alongside browser sessions.
- A zero knowledge canary test in the browser suite, in both modes: unique
  strings typed or uploaded never reach the database, the stored files, the
  logs or the requests in end-to-end mode.

### Drive

- Folders, uploads and downloads of files and folders, resumable uploads of large
  files in fixed-size frames, list and grid views, favorites, tags, recent files
  and trash with a retention period.
- Version history with restore, per-user quotas, a change journal for clients.
- Previews of PDFs, images, video, audio and text, decrypted in the browser and
  streamed through a service worker.
- Search across names, tags and the text of documents and spreadsheets, indexed
  and encrypted on the device.

### Documents

- `.docx` and `.odt` opened, edited and saved back with everything not edited
  written back unchanged; `.md`, `.rtf` and `.txt`; best-effort `.doc` import to
  `.docx`, keeping the original in Versions.
- An editor for everyday writing: headings, formatting, fonts and colours, lists
  and checklists, alignment, links, images, tables, quotes, code, find and
  replace. Content it cannot change is shown, labelled and kept, and a notice per
  file says what was found and how it is handled.
- Print to PDF through the browser. A warning when someone else is editing, and a
  separate copy instead of a lost save.

### Spreadsheets

- `.xlsx` and `.ods` round trips that keep cells and parts not edited, `.csv` and
  `.tsv`, best-effort `.xls` import to `.xlsx`.
- A formula engine in a worker with about 40 functions; formulas it does not
  know keep their text and cached value. A virtualised grid that draws only what
  is in view, with formatting, merges, sorting, a filter, frozen panes, row and
  column edits, copy and paste, and undo.

### Notes

- Markdown notes in coloured notebooks, with tags, pins, an archive, checklists
  with due dates, `[[` links to notes and files that survive renames, backlinks
  and unlinked mentions, slash commands, quick capture, today's note and
  templates.
- Reminders while the app is open. Sharing like any file or folder.
- Exports of one note (Markdown, HTML, PDF by printing, a document in Drive) and
  of every note as a ZIP of Markdown files with working links.

### Sharing

- Grants to other users as viewer or editor, with key pinning and safety numbers,
  so a server cannot silently stand in for the person you share with. Revoking
  rotates the key.
- Public links with an optional password, expiry and download limit, whose key
  stays in the part of the link the browser never sends.

### Administration and operations

- One container (`linux/amd64` and `linux/arm64`) or one static binary (linux and
  darwin), one data directory, nothing downloaded at runtime. Unraid template, and
  guides for reverse proxies and identity providers.
- An admin area for users, quotas, sign-in settings, storage health and the audit
  trail.
- `yondrive backup` takes a consistent snapshot beside the running server;
  `yondrive restore` copies one into a new data directory and never over an
  existing one. Backups leave out the server secret that signs link tokens, and
  `yondrive admin rotate-secret` replaces it after a copy of the data directory
  has left your hands. A drill in the test suite backs up a live server in each mode,
  restores it and checks sign-in, files, versions, notes, shares, links, tokens
  and, in the browser, the canary.
- Schema migrations run on start; `yondrive migrate --check` reports them
  beforehand. Upgrades are tested from every earlier schema version with data
  written at each, and a database from a newer release is refused.
- [docs/OPERATIONS.md](docs/OPERATIONS.md) for operators and
  [docs/API.md](docs/API.md) with a rendered API reference for client authors.

### Builds and releases

- Reproducible builds: the same commit gives the same binary and the same web app
  whether built with `just build` or the Dockerfile; `just verify-reproducible`
  checks it.
- `yondrive version` prints the version, commit and the root hash of the embedded
  web app; `yondrive assets` lists the hash of every file it serves, and
  `yondrive assets check` compares a running server with a published list. The
  health routes and the admin area report the same hash.
- Releases carry SHA256SUMS, an SBOM, keyless signatures over the checksums and
  the image, and build provenance.

### Known limits

These are open, and the README and PLAN say the same:

- **Office files from real applications.** The document and spreadsheet round
  trips are checked on generated and hand-written files only. No corpus of real
  files from Word, Excel or other office applications has been tried, files saved
  here have not been opened in Word, Excel or LibreOffice, and the function table
  has not been checked against Excel itself. `.doc` and `.xls` import has only been
  tried on synthetic files.
- **Browsers and devices.** The browser suite runs in Chromium. Safari (WebKit)
  has not been tested, nor have real phones: phone layouts are checked at phone
  sizes in Chromium only, and streaming throughput and memory on a mid-range phone
  are unmeasured. A real 4 GB video has not been played end to end.
- **The served app.** In end-to-end mode a compromised server could serve a
  modified web app that captures a passphrase. Published hashes and
  `yondrive assets check` help detect that; nothing on the web can prevent it.
- **No independent security review** of the cryptography and the sharing flows
  has been done yet.
- **Notes.** Exports are checked in this app's own tests, not in other Markdown
  editors. Reminders fire only while a tab is open.
- **Not in 1.0:** real-time co-editing, Word-style page layout, charts and pivot
  tables (kept in files, not drawn), `.pages` and `.numbers` in the editors, the
  Media app, native clients, passkey unlock, moving a server between encryption
  modes.
