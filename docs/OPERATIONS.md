# Running YonDrive

For whoever installs, upgrades and looks after a YonDrive server. The
[README](../README.md) says what YonDrive is, [PROXY.md](PROXY.md) and
[OIDC.md](OIDC.md) cover the reverse proxy and single sign-on, and
[RELEASE.md](RELEASE.md) how to verify what you download.

One rule shapes everything below: **a server is one binary and one data
directory.** There is no database to run, nothing is downloaded at runtime, and
the data directory is the whole state. Back it up and you have the server.

## Install

### Docker

The image is `ghcr.io/angelmmiguel/yondrive`, on GitHub's container registry.
Its tags:

- **A version** (`1.0.0`), and `1.0` and `1` for the newest release of that line.
  Built by the release workflow, signed by digest and with build provenance
  ([RELEASE.md](RELEASE.md)). Run one of these.
- **`latest`** follows the main branch: every commit whose CI passes, for
  `linux/amd64` only, unsigned. It reports a version such as
  `0.0.0-main+abc123def456` or `1.0.0-4-gabc123def456` (four commits past 1.0.0).
  For trying what is next, not for data you rely on.

```bash
mkdir -p /srv/yondrive/data && chown 99:100 /srv/yondrive/data
docker run -d --name yondrive --restart unless-stopped \
  -p 8990:8080 \
  -v /srv/yondrive/data:/data \
  -e YONDRIVE_PUBLIC_URL=https://drive.example.com \
  -e YONDRIVE_TRUSTED_PROXIES=172.18.0.0/16 \
  ghcr.io/angelmmiguel/yondrive:1.0.0
```

Or with Compose (the same as [`deploy/compose.yaml`](../deploy/compose.yaml)):

```yaml
services:
  yondrive:
    image: ghcr.io/angelmmiguel/yondrive:1.0.0
    restart: unless-stopped
    ports: ["8990:8080"]
    volumes: ["/srv/yondrive/data:/data"]
    environment:
      YONDRIVE_PUBLIC_URL: https://drive.example.com
      YONDRIVE_TRUSTED_PROXIES: 172.18.0.0/16
```

- A release image is `linux/amd64` and `linux/arm64` (`latest` is `linux/amd64`),
  built `FROM scratch`: the binary, a CA bundle and an empty `/data`, nothing
  else. There is no shell inside it. `docker inspect` shows its version, commit,
  licence and source in the `org.opencontainers.image.*` labels.
- It runs as **uid 99, gid 100** (`nobody:users`, as Unraid's appdata). The data
  directory is written with modes 0700 and 0600, so the mounted directory must
  belong to 99:100, or the server cannot open it.
- Pin a version tag (`1.0.0`, or `1` for the latest 1.x) rather than `latest`,
  which follows `main`. Pin the digest for exactly the same bytes, and verify the
  signature first ([RELEASE.md](RELEASE.md)).

### Unraid

Install the template from `unraid/yondrive.xml` (Docker > Add Container, or
Community Applications once it is listed). It maps the web port to 8990 and
`/data` to `/mnt/user/appdata/yondrive`, which Unraid creates as `nobody:users`.
Fill in the public URL and the trusted proxies if YonDrive sits behind a proxy.
Prefer a pool (cache) path for appdata: the database does many small writes,
which are slow on the parity array.

The template's Repository is `ghcr.io/angelmmiguel/yondrive:latest`, which follows
the main branch. Once a release is out, pin it: edit the container and set
Repository to `ghcr.io/angelmmiguel/yondrive:1.0.0` (or `:1` to follow 1.x), and
change that tag to update.

### The binary

Each release has static binaries for linux and darwin on amd64 and arm64. They
need nothing installed.

```bash
./yondrive-linux-amd64 serve --data /var/lib/yondrive --addr :8080
```

The binary listens on `127.0.0.1:8080` unless told otherwise, so a server on a
machine of its own needs `--addr :8080`. Run it under a service manager as a
dedicated user that owns the data directory.

## Behind a reverse proxy

YonDrive speaks plain HTTP. Put it behind a proxy that provides HTTPS: the
settings it needs (body size, timeouts, no buffering, forwarded headers) and
configurations for Nginx Proxy Manager and Traefik are in [PROXY.md](PROXY.md).
The two settings that matter on the YonDrive side:

- `YONDRIVE_TRUSTED_PROXIES`: the proxy's address or range, so that the visitor's
  address and HTTPS status are believed. If it is wrong, rate limits treat every
  visitor as one, and the admin area shows a warning.
- `YONDRIVE_PUBLIC_URL` (or the public URL in the wizard): the address people
  use, with `https://`. Share links and the single sign-on redirect come from it.

Plain HTTP on a LAN works, with a permanent warning in the app. Anyone on that
network can then read the traffic or change the app, which defeats end-to-end
encryption, and browsers turn off features such as the streaming of large files.

## First run

On its first start, the server prints a one-time setup link. With
`YONDRIVE_PUBLIC_URL` set, it is a whole link:

```bash
docker logs yondrive 2>&1 | grep setup
# level=INFO msg="first-run setup required, open this link" link=https://drive.example.com/setup#…
```

Without it, a server listening on every interface (as the image does) cannot
know the address and port you reach it at, since Docker may map its port 8080
to any other. It prints the path instead, to open on that address:

```bash
# level=INFO msg="first-run setup required, open this path on the address you reach this server at" path=/setup#… listening=:8080 hint="…"
# With -p 8990:8080, open http://<host>:8990/setup#…
```

Open it. The token is in the part after `#`, which the browser never sends to a
proxy's logs. The wizard asks for the server's name and public URL, the
**encryption mode**, which is fixed for good once chosen, and the first
administrator. Every wizard call needs the token, so whoever reaches the server
first cannot take it over. A restart before setup is finished prints a new link,
and the old one stops working.

After setup, the admin area (`/admin`) has users, invitations, quotas, sign-in
and single sign-on, server settings, health and the audit trail.

## Configuration

Most settings live in the admin area and are stored in the database. Only what
must be known at startup is a flag or an environment variable; a flag wins over
its variable.

| Flag | Variable | Default | Purpose |
| --- | --- | --- | --- |
| `--addr` | `YONDRIVE_ADDR` | `127.0.0.1:8080` (`:8080` in the image) | Listen address. `:8080` listens on every interface |
| `--data` | `YONDRIVE_DATA` | `./data` (`/data` in the image) | Data directory. Also read by `backup`, `restore`, `migrate` and `admin` |
| `--public-url` | `YONDRIVE_PUBLIC_URL` | Empty: set in the wizard | Address in share links and for single sign-on. `http://` is accepted, with a warning |
| `--secure` | `YONDRIVE_SECURE` | `auto` | Whether requests count as HTTPS, for `Secure` cookies and HSTS. `auto` follows the connection, or `X-Forwarded-Proto` from a trusted proxy; `true` or `false` force it. Anything else stops the server |
| `--trusted-proxies` | `YONDRIVE_TRUSTED_PROXIES` | Empty | Comma-separated addresses and CIDR ranges whose `X-Forwarded-For` and `X-Forwarded-Proto` are believed |
| `--ca-file` | `YONDRIVE_CA_FILE` | Empty | PEM file of extra certificate authorities, for an identity provider behind an internal one. A file that does not load stops the server |

`yondrive` with no arguments, or with an unknown command, prints the commands
and flags.

## Data directory

```
yondrive.db, -wal, -shm   SQLite in WAL mode: accounts, settings, the tree, versions, grants, links, journal, audit
blobs/ab/<id>             one stored file per version, thumbnail or index segment; never changed once written
uploads/<id>              versions being uploaded; forgotten on restart
uploads/tmp-*             small files on their way in; removed on start
lock                      held by the running server, so nothing else writes beside it
```

It is an internal format in both modes, not a folder tree of your files. In
end-to-end mode it holds ciphertext and metadata that is not secret (sizes,
times, who shares with whom). In mode `none` the stored files are the files,
under opaque ids. To get files out as a normal folder, export them from the app.

Never edit it by hand, and never run two servers on it: the second refuses to
start (`data directory is in use by another process`).

## Backups

`yondrive backup <dest>` takes a consistent snapshot of a running server into an
empty directory:

```bash
# A directory for backups, owned by 99:100 and mounted into the container.
docker run … -v /srv/yondrive/backups:/backups …
docker exec yondrive /yondrive backup /backups/$(date +%F)
```

- It works beside the running server, which keeps serving and writing. The
  database is copied as of one moment, then every file that moment refers to.
- **On the same filesystem, stored files are hard links**, which cost no space
  and are safe because a stored file never changes. (Two bind mounts of a
  container count as two filesystems, so there they are copied.) They do not protect against a
  failing disk, so copy the backup to another disk or machine (`rsync -aH`, or
  any backup tool). On another filesystem they are copied.
- A directory without `yondrive.db` is an unfinished backup. Uploads in progress
  are not included; clients start them again.
- The admin area shows when the last backup finished, and so does
  `GET /api/v1/admin/health` (`last_backup_at`).
- In end-to-end mode a backup is ciphertext, and can go anywhere without trusting
  the destination. In mode `none` it holds your files as they are: encrypt it,
  or keep it as safe as the server.
- A backup leaves out the server secret, which signs public link tokens and
  sign-ins in progress. A server restored from it makes a new one, so readers
  of public links open them again. If the data directory itself, or a backup
  from before 1.0.0, has been copied by someone else, run `admin rotate-secret`
  (below).

Schedule it with cron or Unraid's User Scripts, keep several, and delete old
ones as whole directories.

## Restore

`yondrive restore <backup>` copies a backup into a **new, empty** data directory,
and leaves the backup untouched:

```bash
docker stop yondrive
mkdir /srv/yondrive/data-restored && chown 99:100 /srv/yondrive/data-restored
docker run --rm --user 99:100 \
  -v /srv/yondrive/backups/2026-11-07:/backup:ro \
  -v /srv/yondrive/data-restored:/data \
  --entrypoint /yondrive ghcr.io/angelmmiguel/yondrive:1.0.0 restore /backup
# Point the container at /srv/yondrive/data-restored and start it.
```

- It refuses a data directory with anything in it. Restoring over a live server
  would merge two moments of it into a state that never existed. Move the old
  directory aside instead; delete it once the restored server is checked.
- It refuses a backup taken by a newer release. A backup from an older release is
  restored as it is and migrated when the server starts.
- Run it as the user the server runs as (`--user 99:100` above), so the restored
  files belong to it.
- Using a backup directory directly as the data directory also works, but the
  first start writes to it, so it is no longer the backup you took.

### The drill

A backup you have not restored is a hope. After installing, after each upgrade,
and a few times a year:

1. Take a backup of the running server.
2. Restore it into a new directory, on another machine if you can.
3. Start a second server on it, on another port, and sign in. Open a file you
   know, a note, a shared folder (as the person it is shared with), and an older
   version of something.
4. In end-to-end mode, unlock: this proves the recovery material in the backup is
   whole, not just the files.
5. Stop the second server and delete its directory.

The test suite runs the same drill automatically: `cmd/yondrive/drill_test.go`
backs up a live server in each mode while it writes, restores it, and checks
sign-in, files' bytes, versions, notes, shares, public links and device tokens;
`web/tests/e2e/backup-drill.spec.ts` does it through the browser, and checks
that no canary string typed into the app reached the restored directory in
end-to-end mode.

## Upgrades

1. Read the release's notes in [CHANGELOG.md](../CHANGELOG.md) and verify the
   download ([RELEASE.md](RELEASE.md)).
2. Check what the new release will do to the database, beside the running server
   (it reads without writing):

   ```bash
   docker run --rm --user 99:100 -v /srv/yondrive/data:/data \
     --entrypoint /yondrive ghcr.io/angelmmiguel/yondrive:1.1.0 migrate --check
   # schema 7, binary at 8: 1 migrations to apply, which serve does on start
   ```

3. Take a backup.
4. Replace the container with the new image. On start, the server applies the
   migrations, each in a transaction, before it listens. With the server stopped,
   `yondrive migrate` does the same and reports the result, if you would rather
   see it happen.

   With Compose, change the tag in `compose.yaml`, then
   `docker compose pull && docker compose up -d`. With `docker run`, `docker pull`
   the new tag, `docker stop yondrive && docker rm yondrive`, and run it again with
   the same volume and settings. On Unraid, edit the container and change the tag
   in Repository.

There is **no downgrade**. A database migrated by a newer release is refused by
an older one (`database schema is newer than this binary`). To go back, restore
the backup taken before the upgrade and run the old release on it.

Every upgrade path is tested: `internal/store/upgrade_test.go` builds a database
at every earlier schema version with data written at each, and migrates it to the
latest.

## Monitoring

- **Liveness:** `GET /api/v1/health` answers `200` with
  `{"status":"ok","version":…,"commit":…,"web_bundle":…,"setup":true,"mode":…}`,
  without signing in. Point an uptime monitor at it. The image has no shell or
  curl, so it defines no Docker `HEALTHCHECK`; check from outside.
- **Storage:** the admin area's Server tab, or `GET /api/v1/admin/health` as an
  admin, shows the stored bytes and files, uploads in progress and what they
  reserve, files waiting to be removed, free disk space, the last backup, and the
  number of single sign-on accounts. Watch free space and the last backup.
  "Waiting to be removed" drains on its own within an hour; one that only grows
  means the sweeper cannot unlink files, usually a permission problem.
- **Version:** the same routes report the version, the commit and the hash of the
  web app; [RELEASE.md](RELEASE.md) shows how to compare them with a release.

## Logs

The server logs to standard error, one line per event in logfmt
(`time=… level=INFO msg=…`).

- At start: the setup link while setup is pending, then `listening` with the
  address, the data directory, the version, the commit and the web app's hash.
- One `request` line per request: method, path, status, bytes, duration and the
  client address. Never bodies, query strings, cookies or tokens.
- Warnings and errors: sign-in failures from a provider, the sweeper, and the
  occasional client that disconnected mid-transfer.

The logs hold client addresses. They never hold content, file names, keys or
passphrases; the canary tests check that in both modes. Rotate them with Docker's log options.

## Admin commands

Operator commands run against the data directory **with the server stopped**:
they take the directory's lock, which the running server holds, so they refuse
to run beside it. Each changes one user and is written to the audit trail.

```bash
docker stop yondrive
docker run --rm --user 99:100 -v /srv/yondrive/data:/data \
  --entrypoint /yondrive ghcr.io/angelmmiguel/yondrive:1.0.0 admin reset-totp alice
docker start yondrive
```

| Command | Does |
| --- | --- |
| `admin reset-totp <user>` | Turns off a user's TOTP and deletes their recovery codes, for someone who lost both. They sign in with their passphrase alone and can enrol again |
| `admin promote <user>` | Makes a user an enabled admin |
| `admin password-reset <user>` | Mode `none` only: prints a one-time reset link, valid 24 hours |
| `admin rotate-secret` | Replaces the server secret. Run it when a copy of the database has left your hands: the data directory itself, or a backup taken before 1.0.0. Readers of public links open them again; sign-ins in progress start over. Accounts, sessions and links are untouched |

Commands that work beside the running server: `backup`, `migrate --check`,
`version`, `assets` and `assets check`.

## When things break

| Symptom | Cause and fix |
| --- | --- |
| `data directory is in use by another process` | Another server or an admin command has the directory. Stop it; never run two |
| `permission denied` opening the data directory, or the container restarting at once | The directory does not belong to the user the server runs as. `chown -R 99:100` it for the image |
| `database schema is newer than this binary` | A newer release migrated this database. Run that release or a later one, or restore a backup from before the upgrade |
| The setup link is lost | Restart the server before setup is complete; it prints a new one |
| The admin area warns that requests look proxied by an untrusted address | Set `YONDRIVE_TRUSTED_PROXIES` to the proxy's address ([PROXY.md](PROXY.md)) |
| Uploads fail with 413, or stall on large files | The proxy's body size or timeouts ([PROXY.md](PROXY.md)) |
| Sign-in through the provider fails with a code | The code's meaning and the usual fixes are in [OIDC.md](OIDC.md#when-it-fails); the details are in the log |
| Video does not stream, or a warning about plain HTTP | Serve it over HTTPS; browsers keep service workers from plain HTTP |
| The disk is full | Empty the trash and look at quotas. Purged files are unlinked after the grace period set in the admin area, by the hourly sweep |
| `--ca-file` or `--secure` stops the server | The file cannot be read as PEM, or the value is not `auto`, `true` or `false` |

## Resetting a second factor

A user who lost their authenticator **and** their TOTP recovery codes cannot
sign in. Check who is asking (TOTP exists to stop someone with only the
passphrase), then run `admin reset-totp <user>` as above. Their passphrase,
keys and files are untouched. An account that signs in through the identity
provider uses the provider's second factor instead; reset it there.

## Recovering an admin

In order of preference:

1. **Another admin** signs in and fixes it from the admin area: re-enables the
   account, or in mode `none` issues a password reset link.
2. **The fallback admin.** The oldest enabled admin with a passphrase can always
   sign in with it, even with local accounts off or the identity provider down
   ([OIDC.md](OIDC.md#admins-local-accounts-and-getting-back-in)).
3. **The recovery key**, in end-to-end mode: on the sign-in page, "Forgot your
   passphrase?" takes the 24 words and sets a new passphrase. Nobody else can do
   this for them, by design.
4. **The command line**, with the server stopped: `admin promote <user>` makes any
   account that can still sign in an admin, and enables it if it was disabled. In
   mode `none`, `admin password-reset <user>` gives a locked-out admin a reset
   link.

If the only admin lost both passphrase and recovery key in end-to-end mode, their
files are gone: that is what zero knowledge means. Promote another account with
`admin promote` to keep running the server. When the admin group of an identity
provider decides who is an admin, the next sign-in through it can undo a
promotion; make the change at the provider as well.

## Moving to another server

1. Install the same release, or a newer one, on the new machine.
2. Take a backup on the old server, copy it across (`rsync -aH` keeps hard links,
   though a fresh copy is just as good), and `yondrive restore` it there into an
   empty data directory owned by the server's user.
3. If the address changes, set the new public URL (`YONDRIVE_PUBLIC_URL`, or the
   admin area), update the redirect URI at the identity provider, and point the
   proxy at the new machine. Share links that people already have carry the old
   address.
4. Start the new server, do the drill's checks, then stop and remove the old one.
   Never run both on copies of the same data for long: they diverge, and
   neither can take the other's changes.

The encryption mode moves with the data and cannot be changed on the way. Keys
are in the data, sealed by each user's passphrase, so nothing needs re-keying.
