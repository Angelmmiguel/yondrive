# YonDrive

Your files, documents and notes on your own server, readable only by you.

YonDrive is a self-hosted alternative to Google Drive and Dropbox, built around
zero-knowledge encryption. By default, everything is encrypted in the browser
before it is uploaded, so the machine hosting your data, and whoever administers
it, holds only ciphertext. It runs as one container with one data directory.

> **Status: 1.0.** Drive, sharing, search, documents, spreadsheets and notes are
> released. File requests and comments come next. [PLAN.md](PLAN.md) tracks what
> is done, what is planned and what is still unverified.

## Why YonDrive

- **Private by construction.** In end-to-end mode, file contents, names, tags,
  thumbnails, notes and search indexes never reach the server in the clear.
- **Easy to run.** No separate database, office server or sidecar
  containers. Start one container, open the URL and follow the setup wizard.
- **Self-contained.** Your content never goes to an external service. Everything
  that works on it runs on your device, from code your own server delivers.
- **Small and understandable.** Documents and spreadsheets use a focused editor
  built for this project, not a full office suite. It covers everyday work and
  leaves alone what it does not understand.

## Features

### Drive

- Folders, upload and download of files or whole folders, with resumable
  transfers for large files
- List and grid views, tags, favorites, recent files and trash
- Version history with restore
- Instant search across names, tags and the text of documents and spreadsheets,
  computed on your device
- Previews for PDFs, images, video, audio and text
- Per-user storage quotas

### Documents

Open documents in the browser and edit them with no conversion server and no
external service. Everything is parsed and written on your device.

| Format | Open | Edit | Saved back as |
| --- | --- | --- | --- |
| `.docx`, `.odt` | Yes | Yes | The same format; what you did not edit is written back unchanged |
| `.md` | Yes | Yes | The same format; blocks you did not edit are written back unchanged |
| `.rtf`, `.txt` | Yes | Yes | The same format, rewritten whole |
| `.doc` | Text and basic formatting, best effort | After conversion | `.docx`; the original stays in Versions |

Apple `.pages` files are stored, shared and downloaded like any other file, and
do not open in the editors in v1.

**The editor covers everyday use, on purpose:** headings, text formatting, fonts
and colors, lists and checklists, alignment, links, images, tables, quotes, code,
and find and replace. There is one continuous page view, not Word-style page
layout. Markdown and plain text offer only what they can store.

**Your file stays intact.** Paragraphs you do not edit are written back exactly
as they were, and the parts of the file the editor does not read, such as macros,
comments, headers and footers, stay as they were. Content it cannot change, such
as tracked changes, equations, fields and text boxes, is shown, labelled and kept
instead of being dropped. A notice above each document lists what that file holds
and how it is handled. Saving in another format keeps the original in Versions,
and says first what cannot be carried over.

**What has been tested, and what has not.** The round trip is checked
automatically on files we generate: documents written by pandoc, a synthetic
`.doc`, and damaged and oversized files. It has not yet been checked on a corpus
of real files from Word and other office applications, and files saved here have
not been opened in Word to confirm it accepts them. `.doc` import has only been
tried on synthetic files.

If someone else is already editing a file, YonDrive warns you. There is no
real-time co-editing. If two people save anyway, the second save becomes a
separate copy, so neither loses work.

To turn a document into a PDF, use **Print** and your browser's "Save as PDF".

### Spreadsheets

Open spreadsheets in the browser, with the formulas calculated on your device
by an engine written for this project.

| Format | Open | Edit | Saved back as |
| --- | --- | --- | --- |
| `.xlsx` | Yes | Yes | `.xlsx`; cells and parts you did not edit are written back unchanged |
| `.ods` | Yes | Yes | `.ods`; cells you did not edit are written back unchanged |
| `.csv`, `.tsv` | Yes | Yes | The same format, one sheet of values; unchanged lines are kept as they were |
| `.xls` | Values, formulas and basic formatting, best effort | After conversion | `.xlsx`; the original stays in Versions |

Any of them downloads as `.xlsx`, `.ods`, or the current sheet as `.csv` or
`.tsv`. Apple `.numbers` files are stored like any other file and do not open
in v1.

**The editor covers everyday use, on purpose:** number formats, font size, bold,
italic, strikethrough, text and fill color, borders, merged cells, alignment and
wrapping, sorting, a filter that hides rows while you look, frozen rows and
columns, column widths and row heights, inserting and deleting rows, columns and
sheets, copy and paste with other spreadsheets, and undo. About 40 functions are
calculated: `SUM`, `AVERAGE`, `IF`, `VLOOKUP`, `INDEX`, `MATCH`, `SUMIF`, `TEXT`,
`DATE` and their everyday companions. The status bar sums, counts and averages
the selection. Charts and pivot tables are not drawn or edited.

**Your file stays intact.** A formula that uses a function this app does not
calculate keeps its text and the value the file had, is marked, and cannot be
edited here; cells that read it use that value. Charts, pivot tables, comments
and other parts the editor does not show stay in the file. Inserting or deleting
rows moves formulas, merges and filters, but charts and pivot tables keep their
old ranges, and the editor warns before doing it in a file that has them. A
notice above each sheet lists what that file holds and how it is handled.

**What has been tested, and what has not.** Formulas are checked against a table
of expected results taken from Excel's documentation, and the round trip on
files written by hand to each format's layout. Files saved here have not been
opened in Excel or LibreOffice, no corpus of real spreadsheets has been tried,
and `.xls` import has only been tried on a synthetic file.

The same warning as for documents tells you when someone else is editing, and a
second save becomes a separate copy. To print, or to save as a PDF, use **Print**.

### Notes

- Markdown notes with notebooks in colours, tags, pins, an archive and checklists,
  where a task can end with a due date such as `@2026-11-20`
- Type `[[` to link a note or a Drive file; links keep working when either is
  renamed, and each note shows its backlinks and the notes that mention it
  without a link, with a button to link them
- Slash commands for headings, checklists, code, callouts, tables, pictures and
  files; quick capture; today's note; templates, your own included (the notes
  of a notebook called Templates)
- Reminders, shown while YonDrive is open in a tab
- Share a note or a notebook like any file or folder
- Export a note as Markdown, HTML or a PDF (by printing), or save it to Drive as
  a document; export every note as a ZIP of Markdown files in a folder per
  notebook, with links between them and pictures that work in other editors

Notes are Markdown files kept with your other files, so they have versions and
count towards your storage, and a file edited in another Markdown editor keeps
what Notes does not show. Pictures in a note are files beside it. Links are
written `[Title](yondrive:node/<id>)`, which other editors show as links and
the ZIP export turns into relative paths.

### Sharing

- Share files and folders with other users as viewer or editor
- Public links with optional password, expiry and revocation
- In end-to-end mode, the decryption key sits in the part of the link after `#`,
  which browsers never send to the server, and user keys can be verified, so a
  compromised server cannot silently stand in for the person you share with

### Accounts and administration

- Multiple users, by invitation or open sign-up
- Local accounts, two-factor authentication and single sign-on through OpenID
  Connect, with guides for Pocket ID, Authelia, Authentik and Keycloak
- A first-run wizard, then an admin area for users, quotas, sign-in and storage
- Light and dark themes

### For developers

- A versioned HTTP API described by an [OpenAPI](https://www.openapis.org/) spec
  served by the application
- A language-independent specification of the encryption format, with test
  vectors, so iOS, Android and other clients can interoperate

## Choosing an encryption mode

You choose once, during setup, for the whole server. The choice cannot be changed
later.

|  | End-to-end (recommended) | No encryption |
| --- | --- | --- |
| Features and speed of the app | Identical | Identical |
| Who can read your files | Only you and those you share with | Anyone with access to the server or its disks |
| Forgotten password | Recovery key only; nobody else can help | An admin can reset it |
| Recovery key | Required for each user | Not used |

With no encryption, files are stored as they are and everything else works the
same way, including search and thumbnails, which are still built on your device.
Use disk encryption such as LUKS or ZFS native encryption to protect against
stolen drives. The rest of this README refers to end-to-end mode unless it says
otherwise.

## Your recovery key matters

Every user gets their own recovery key when they create their account. It is
generated on their device and shown once.

**If you lose both your passphrase and your recovery key, your files are gone.**
No administrator can reset them, and neither can anyone with access to the
server. This is the point of the design: anyone able to rescue your files could
also read them. Store the key somewhere safe, away from the server.

Local accounts use one passphrase for both signing in and decrypting. Single
sign-on users sign in with their identity provider, and choose a separate unlock
passphrase that is never sent to the server.

## What zero knowledge does and does not protect

YonDrive protects you if someone obtains a copy of the data directory, the
database or a backup, and against an administrator browsing your files.

It does not hide everything, and we would rather say so:

- **The server sees metadata:** who your users are, the folder structure as
  anonymous ids, file sizes, when things change, who shares with
  whom, and who is currently editing a file. It cannot see names, types or
  contents.
- **The server delivers the web app.** Someone who takes control of the running
  server could serve a modified app that captures your passphrase the next time
  you unlock. The same is true of every browser-based end-to-end encrypted
  service. Reproducible builds and published hashes of the app let you check
  what a server serves ([docs/RELEASE.md](docs/RELEASE.md)), and native clients
  will reduce the risk, but nothing removes it for the web app.
- **Revoking a share is not retroactive.** Revocation stops future access, but
  it cannot erase what someone already downloaded.
- **Your device is trusted.** Malware on an unlocked device can read what you
  can read.

The full threat model is in [docs/SECURITY.md](docs/SECURITY.md).

## Trade-offs of working on the client

In both modes the server only stores data. It never processes your content:

- A new device spends a while downloading and building its search index.
- Search and thumbnails are generated by whichever device uploads or indexes.
- Video plays only if your browser supports its codec. The server does not
  transcode it.
- There is no server-side WebDAV or SMB.

## Deployment

The image is `ghcr.io/angelmmiguel/yondrive`:

```bash
mkdir -p data && sudo chown 99:100 data
docker run -d --name yondrive --restart unless-stopped \
  -p 8990:8080 \
  -v "$PWD/data:/data" \
  -e YONDRIVE_PUBLIC_URL=http://localhost:8990 \
  ghcr.io/angelmmiguel/yondrive:latest
docker logs yondrive 2>&1 | grep setup
```

Or with Docker Compose, from [`deploy/compose.yaml`](deploy/compose.yaml):
`docker compose up -d`.

The container logs a one-time setup link. Open it to choose the encryption mode
and create the first administrator. Without `YONDRIVE_PUBLIC_URL` it logs the
path, `/setup#…`, to open on the address and port you mapped.

**Which tag.** `latest` follows the main branch: every commit that passes CI,
unsigned. A version tag (`1.0.0`, or `1.0` and `1` for the newest of that line)
is a release, signed and with build provenance, and is what to run for anything
you rely on. To update, change the tag, pull and recreate the container
(`docker compose pull && docker compose up -d`); [the operator
guide](docs/OPERATIONS.md#upgrades) has the steps, including the backup first.

The image holds everything YonDrive needs and never downloads anything at
runtime: one Go binary with the web app embedded.

**HTTPS.** The container speaks plain HTTP. The usual setup puts it behind a
reverse proxy such as Nginx Proxy Manager or Traefik, which provides HTTPS. Set
`YONDRIVE_TRUSTED_PROXIES` to the proxy's address so that YonDrive sees the real
visitor address and HTTPS status.

Using it directly over plain HTTP on a LAN also works, with a visible warning.
Anyone on that network could read your traffic or tamper with the app, which
defeats end-to-end encryption, and browsers disable some features there, such as
streaming large files.

**Unraid.** A Docker template is in `unraid/yondrive.xml`, in the same form as
other Community Applications templates.

**Backups.** In end-to-end mode the data directory holds only ciphertext and
non-secret metadata, so it can be copied to any backup destination without
trusting that destination. `yondrive backup <dest>` takes a consistent snapshot while
the server is running, into an empty directory, and the admin area shows when it
last finished. To restore, stop the server and use that directory as the data
directory. On the same filesystem the files of a backup are hard links, which
cost no space but do not survive a failing disk, so point it at another disk. The
directory is an internal format in both modes, not a browsable folder tree, so
export your files from the app to get them back as a normal folder.

### Configuration

Most settings live in the admin UI. Only what has to be known at startup is
set in the environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `YONDRIVE_ADDR` | `127.0.0.1:8080` (`:8080` in the image) | Listen address |
| `YONDRIVE_DATA` | `./data` (`/data` in the image) | Data directory |
| `YONDRIVE_PUBLIC_URL` | Set in the wizard | Address used in share links and for OIDC |
| `YONDRIVE_SECURE` | `auto` | Mark cookies `Secure`: `auto` follows the HTTPS status reported by a trusted proxy |
| `YONDRIVE_TRUSTED_PROXIES` | Empty | Proxy addresses or CIDRs whose forwarded headers are trusted |
| `YONDRIVE_CA_FILE` | Empty | PEM file of certificate authorities to trust as well as the image's bundle, for an internal identity provider |

Guides: [running a server](docs/OPERATIONS.md) (installing, backups and
restore, upgrades, monitoring, recovery), [reverse proxies](docs/PROXY.md),
[identity providers](docs/OIDC.md), [verifying a release](docs/RELEASE.md) and
[the API](docs/API.md).

## Development

The toolchain is a Nix flake, and direnv can load it automatically. Once the
project is scaffolded:

```bash
nix develop        # or: direnv allow
just web-install   # pnpm install, once
just dev           # Go server on :8080 and Vite on :5173
just test          # go test -race and vitest
just lint          # go vet, golangci-lint, svelte-check, eslint, prettier
just api           # regenerate Go and TypeScript code from the OpenAPI spec
just web-e2e       # Playwright specs against throwaway servers, in both modes
just build         # build the web app and a Go binary that embeds it
```

## Technology

- **Server:** Go, with SQLite for metadata and plain files for content
- **Web app:** SvelteKit with Svelte 5, compiled statically and embedded in the
  binary
- **Cryptography:** Argon2id, XChaCha20-Poly1305, X25519 and Ed25519, through the
  audited `@noble` libraries
- **Office formats:** our own file readers and writers, running in web workers,
  with ProseMirror for editing
- **API:** OpenAPI 3.1, written first, with server and client code generated
  from it

## License

[GNU Affero General Public License v3.0](LICENSE).
