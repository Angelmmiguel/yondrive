# YonDrive

Your files, documents and notes on your own server, readable only by you.

YonDrive is a self-hosted alternative to Google Drive and Dropbox, built around
zero-knowledge encryption. By default, everything is encrypted in the browser
before it is uploaded, so the machine hosting your data, and whoever administers
it, holds only ciphertext. It runs as one container with one data directory.

> **Status: planning.** Nothing described here is implemented yet. This README
> describes the intended v1 and [PLAN.md](PLAN.md) describes how to get there.

## Why YonDrive

- **Private by construction.** In end-to-end mode, file contents, names, tags,
  thumbnails, notes and search indexes never reach the server in the clear.
- **Easy to run.** No database server, no Redis, no office server and no sidecar
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
- Instant search across names, tags and document text, computed on your device
- Previews for PDFs, images, video, audio and text
- Per-user storage quotas

### Documents and spreadsheets

Open office files in the browser and edit them with no conversion server and no
external service. Everything is parsed and written on your device.

| Format | Open | Edit | Saved back as |
| --- | --- | --- | --- |
| `.docx`, `.odt` | Yes | Yes | The same format |
| `.rtf`, `.md`, `.txt` | Yes | Yes | The same format |
| `.doc` | Text and basic formatting | After conversion | `.docx`; the original stays in Versions |
| `.xlsx`, `.ods` | Yes | Yes | The same format |
| `.csv`, `.tsv` | Yes | Yes | The same format |
| `.xls` | Values, formulas and basic formatting | After conversion | `.xlsx`; the original stays in Versions |

Apple `.pages` and `.numbers` files can be stored, shared and downloaded like any
other file, but do not open in the editors in v1.

**The editors cover everyday use, on purpose:**

- **Documents:** headings, text formatting, fonts and colors, lists and
  checklists, alignment, links, images, tables, quotes, code, find and replace.
  There is one continuous page view, not Word-style page layout.
- **Spreadsheets:** multiple sheets, number formats, cell formatting, merged
  cells, sort and filter, and a built-in formula engine with the common functions
  (`SUM`, `IF`, `VLOOKUP`, `SUMIF`, `TEXT`, and so on).

**Your file stays intact.** Paragraphs and cells you do not edit are written back
exactly as they were. Content the editors cannot show or change, such as macros,
tracked changes, charts and pivot tables, is kept in the file and flagged instead
of being dropped. Cells using an unsupported formula keep their last value and
are shown as read-only.

If someone else is already editing a file, YonDrive warns you. There is no
real-time co-editing. If two people save anyway, the second save becomes a
separate copy, so neither loses work.

To turn a document into a PDF, use **Print** and your browser's "Save as PDF".

### Notes

- Markdown notes with notebooks, tags, pins and checklists
- `[[Wiki links]]` to notes and Drive files, with backlinks
- Slash commands, quick capture, daily notes and templates
- Export to Markdown, PDF or HTML, or save a note to Drive as a document

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
  anonymous ids, approximate file sizes, when things change, who shares with
  whom, and who is currently editing a file. It cannot see names, types or
  contents.
- **The server delivers the web app.** Someone who takes control of the running
  server could serve a modified app that captures your passphrase the next time
  you unlock. The same is true of every browser-based end-to-end encrypted
  service. Native clients and reproducible builds reduce this risk but do not
  remove it for the web app.
- **Revoking a share is not retroactive.** Revocation stops future access, but
  it cannot erase what someone already downloaded.
- **Your device is trusted.** Malware on an unlocked device can read what you
  can read.

The full threat model will live in `docs/SECURITY.md`.

## Trade-offs of working on the client

In both modes the server only stores data. It never processes your content:

- A new device spends a while downloading and building its search index.
- Search and thumbnails are generated by whichever device uploads or indexes.
- Video plays only if your browser supports its codec. The server does not
  transcode it.
- There is no server-side WebDAV or SMB.

## Deployment

```bash
mkdir -p data && chown 99:100 data
docker run -d --name yondrive \
  -p 8990:8080 \
  -v "$PWD/data:/data" \
  ghcr.io/angelmmiguel/yondrive
```

The container logs a one-time setup link. Open it to choose the encryption mode
and create the first administrator.

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

**Unraid.** A Docker template will ship in `unraid/yondrive.xml`, in the same
form as other Community Applications templates.

**Backups.** In end-to-end mode the data directory holds only ciphertext and
non-secret metadata, so it can be copied to any backup destination without
trusting that destination. `yondrive backup` takes a consistent snapshot while
the server is running. The directory is an internal format in both modes, not a
browsable folder tree, so export your files from the app to get them back as a
normal folder.

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
- **Office formats:** our own file readers and writers and our own formula engine,
  running in web workers
- **API:** OpenAPI 3.1, written first, with server and client code generated
  from it

## License

[GNU Affero General Public License v3.0](LICENSE).
