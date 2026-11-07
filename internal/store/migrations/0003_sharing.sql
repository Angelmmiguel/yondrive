-- Sharing: grants to users, public links, and the generations of a node key.
--
-- The journal now has one row per user who can reach what changed, written when
-- it changes, so owner_id becomes user_id: whose journal the row is in.

ALTER TABLE changes RENAME COLUMN owner_id TO user_id;
DROP INDEX changes_owner;
CREATE INDEX changes_user ON changes (user_id, seq);

-- A node's key starts at generation 1 and rotating it adds one. A version stays
-- sealed under the generation it was written with.
ALTER TABLE nodes ADD COLUMN key_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE versions ADD COLUMN key_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE uploads ADD COLUMN key_generation INTEGER NOT NULL DEFAULT 1;

-- The chain back through a node's keys: the key of a generation, sealed under
-- the next one. Holding a key opens every older one and no newer one.
CREATE TABLE node_key_history (
    node_id    TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    sealed_key BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, generation)
) STRICT, WITHOUT ROWID;

-- sealed_key and signature are empty in no-encryption mode. read_at is when the
-- grantee marked the notification this row makes as read.
CREATE TABLE grants (
    id             TEXT PRIMARY KEY,
    node_id        TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    grantee_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    granter_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role           TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    key_generation INTEGER NOT NULL,
    sealed_key     BLOB NOT NULL,
    signature      BLOB NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    read_at        INTEGER,
    UNIQUE (node_id, grantee_id)
) STRICT;

CREATE INDEX grants_grantee ON grants (grantee_id, id);
CREATE INDEX grants_granter ON grants (granter_id, id);

-- A trigger, so that a grant that goes with its node or its owner tells the
-- grantee as well. The row of a grantee being deleted has gone by then.
CREATE TRIGGER grants_revoked AFTER DELETE ON grants
WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.grantee_id)
BEGIN
    INSERT INTO changes (user_id, node_id, op, at) VALUES (OLD.grantee_id, OLD.node_id, 'revoked', unixepoch());
END;

-- sealed_key opens with the link key, and owner_sealed_key holds that key for
-- whoever made the link. kdf and auth_hash are set on a link with a password,
-- and password_wrapped_key too in end-to-end mode.
CREATE TABLE links (
    id                   TEXT PRIMARY KEY,
    node_id              TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    owner_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role                 TEXT NOT NULL CHECK (role = 'view'),
    key_generation       INTEGER NOT NULL,
    sealed_key           BLOB NOT NULL,
    owner_sealed_key     BLOB NOT NULL,
    kdf                  BLOB,
    password_wrapped_key BLOB,
    auth_hash            BLOB,
    expires_at           INTEGER,
    download_limit       INTEGER,
    download_count       INTEGER NOT NULL DEFAULT 0,
    revoked_at           INTEGER,
    created_at           INTEGER NOT NULL
) STRICT;

CREATE INDEX links_owner ON links (owner_id, id);
CREATE INDEX links_node ON links (node_id);

-- What a link's download limit has counted: a file counts once per viewing
-- session, however many ranges it takes to read it.
CREATE TABLE link_downloads (
    link_id    TEXT NOT NULL REFERENCES links (id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    blob_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (link_id, session_id, blob_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX link_downloads_created ON link_downloads (created_at);
