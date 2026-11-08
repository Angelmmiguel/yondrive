-- File requests. A link of kind `request` takes files into its folder from people
-- with no account, who can read nothing there. What they send waits as an incoming
-- item, outside the tree, until the owner's client adopts it.
--
-- links is rebuilt, as a role now belongs to a view link alone. link_downloads
-- refers to it, so it is set aside and comes back once the rebuild is done.

CREATE TABLE link_downloads_kept AS SELECT link_id, session_id, blob_id, created_at FROM link_downloads;
DROP TABLE link_downloads;

-- public_key is the request's X25519 key, and owner_sealed_key its private key
-- under the owner's master key; both are empty in no-encryption mode. The limits
-- are in plaintext bytes, and NULL means none. files_received and bytes_received
-- count what has arrived or is on its way.
CREATE TABLE links_new (
    id                   TEXT PRIMARY KEY,
    node_id              TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    owner_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind                 TEXT NOT NULL DEFAULT 'view' CHECK (kind IN ('view', 'request')),
    role                 TEXT CHECK (role = 'view'),
    key_generation       INTEGER NOT NULL,
    sealed_key           BLOB NOT NULL,
    owner_sealed_key     BLOB NOT NULL,
    public_key           BLOB,
    kdf                  BLOB,
    password_wrapped_key BLOB,
    auth_hash            BLOB,
    expires_at           INTEGER,
    download_limit       INTEGER,
    download_count       INTEGER NOT NULL DEFAULT 0,
    max_file_size        INTEGER,
    file_limit           INTEGER,
    bytes_limit          INTEGER,
    files_received       INTEGER NOT NULL DEFAULT 0,
    bytes_received       INTEGER NOT NULL DEFAULT 0,
    revoked_at           INTEGER,
    created_at           INTEGER NOT NULL,
    CHECK ((kind = 'view') = (role IS NOT NULL)),
    CHECK ((kind = 'request') = (public_key IS NOT NULL))
) STRICT;

INSERT INTO links_new (id, node_id, owner_id, kind, role, key_generation, sealed_key, owner_sealed_key, kdf,
    password_wrapped_key, auth_hash, expires_at, download_limit, download_count, revoked_at, created_at)
SELECT id, node_id, owner_id, 'view', role, key_generation, sealed_key, owner_sealed_key, kdf,
    password_wrapped_key, auth_hash, expires_at, download_limit, download_count, revoked_at, created_at
FROM links;

DROP TABLE links;
ALTER TABLE links_new RENAME TO links;
CREATE INDEX links_owner ON links (owner_id, id);
CREATE INDEX links_node ON links (node_id);

CREATE TABLE link_downloads (
    link_id    TEXT NOT NULL REFERENCES links (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    blob_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (link_id, session_id, blob_id)
) STRICT, WITHOUT ROWID;

INSERT INTO link_downloads SELECT link_id, session_id, blob_id, created_at FROM link_downloads_kept;
DROP TABLE link_downloads_kept;
CREATE INDEX link_downloads_created ON link_downloads (created_at);

-- An upload through a request names its link. Its node is the request's folder,
-- and its user the owner, whose quota holds the reservation.
ALTER TABLE uploads ADD COLUMN link_id TEXT REFERENCES links (id) ON DELETE CASCADE;
CREATE INDEX uploads_link ON uploads (link_id) WHERE link_id IS NOT NULL;

-- An incoming item: a file sent through a request. Its id is the one its node
-- will have, and blob_id that of its upload and then of its blob, since both enter
-- what the uploader sealed. sealed_key is its node key sealed to the request's
-- public key. completed_at is NULL while the upload is under way.
CREATE TABLE incoming (
    id              TEXT PRIMARY KEY,
    link_id         TEXT NOT NULL REFERENCES links (id) ON DELETE CASCADE,
    owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    blob_id         TEXT NOT NULL UNIQUE,
    version_id      TEXT NOT NULL UNIQUE,
    suite           TEXT NOT NULL,
    sealed_key      BLOB NOT NULL,
    sealed_metadata BLOB NOT NULL,
    size            INTEGER NOT NULL,
    stored_size     INTEGER NOT NULL,
    frame_count     INTEGER NOT NULL,
    frame_size      INTEGER NOT NULL,
    frame_hashes    BLOB,
    created_at      INTEGER NOT NULL,
    completed_at    INTEGER
) STRICT;

CREATE INDEX incoming_owner ON incoming (owner_id, id) WHERE completed_at IS NOT NULL;
CREATE INDEX incoming_link ON incoming (link_id);

-- An upload that goes before it completes, aborted or dropped as stale, takes its
-- item with it.
CREATE TRIGGER uploads_incoming AFTER DELETE ON uploads
WHEN OLD.link_id IS NOT NULL
BEGIN
    DELETE FROM incoming WHERE blob_id = OLD.id AND completed_at IS NULL;
END;

-- An item that goes, however it goes, takes its upload or its blob with it, unless
-- its blob has been adopted into a node. One that never completed gives its room
-- on the link back.
CREATE TRIGGER incoming_dropped AFTER DELETE ON incoming
BEGIN
    UPDATE links SET files_received = files_received - 1, bytes_received = bytes_received - OLD.size
        WHERE id = OLD.link_id AND OLD.completed_at IS NULL;
    DELETE FROM uploads WHERE id = OLD.blob_id;
    DELETE FROM blobs WHERE id = OLD.blob_id AND node_id IS NULL;
END;
