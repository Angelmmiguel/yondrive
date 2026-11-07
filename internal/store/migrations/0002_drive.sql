-- The drive: a tree of opaque nodes, versions of their content, stored files and
-- a journal. Everything sealed is opaque to the server, in both modes.
--
-- Triggers keep the counters: a row deleted by a foreign key cascade, however
-- deep, still releases its quota and queues its file.

ALTER TABLE users ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN reserved_bytes INTEGER NOT NULL DEFAULT 0;

-- The root of a tree has no parent and no name tag. current_version has no
-- foreign key: a version already references its node, and a cycle of them could
-- not be cascaded.
CREATE TABLE nodes (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    parent_id       TEXT REFERENCES nodes (id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
    suite           TEXT NOT NULL,
    sealed_metadata BLOB NOT NULL,
    wrapped_key     BLOB NOT NULL,
    name_tag        BLOB,
    current_version TEXT,
    trashed_at      INTEGER,
    purged_at       INTEGER,
    remove_at       INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    CHECK ((parent_id IS NULL) = (name_tag IS NULL)),
    CHECK ((parent_id IS NOT NULL) OR kind = 'folder')
) STRICT;

CREATE UNIQUE INDEX nodes_root ON nodes (owner_id) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX nodes_name ON nodes (parent_id, name_tag) WHERE trashed_at IS NULL AND parent_id IS NOT NULL;
CREATE INDEX nodes_parent ON nodes (parent_id, id);
CREATE INDEX nodes_trash ON nodes (owner_id, id) WHERE trashed_at IS NOT NULL;
CREATE INDEX nodes_retention ON nodes (trashed_at) WHERE trashed_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX nodes_remove ON nodes (remove_at) WHERE remove_at IS NOT NULL;

-- A stored file. node_id is NULL for a blob tied only to its owner. A content
-- blob's ref_count is the number of versions pointing at it; when that reaches
-- zero the row goes. Thumbnails and index segments have no versions and are
-- deleted directly.
CREATE TABLE blobs (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id    TEXT REFERENCES nodes (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('content', 'thumb', 'index')),
    suite      TEXT NOT NULL,
    size       INTEGER NOT NULL CHECK (size >= 0),
    ref_count  INTEGER NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX blobs_owner ON blobs (owner_id, kind, id);
CREATE INDEX blobs_node ON blobs (node_id);
CREATE UNIQUE INDEX blobs_thumb ON blobs (node_id) WHERE kind = 'thumb';

-- author_id and content_author_id have no foreign key: a version outlives the
-- account of whoever wrote it, for as long as its node lasts. A restored version
-- is a new row over the old blob, which stays sealed under the id it was written
-- with: that is content_version_id, and content_author_id is who signed it.
CREATE TABLE versions (
    seq                INTEGER PRIMARY KEY AUTOINCREMENT,
    id                 TEXT NOT NULL UNIQUE,
    node_id            TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    blob_id            TEXT NOT NULL REFERENCES blobs (id),
    suite              TEXT NOT NULL,
    author_id          TEXT NOT NULL,
    content_version_id TEXT NOT NULL,
    content_author_id  TEXT NOT NULL,
    stored_size        INTEGER NOT NULL,
    frame_count        INTEGER NOT NULL,
    frame_size         INTEGER NOT NULL,
    frame_hashes       BLOB NOT NULL,
    signature          BLOB NOT NULL,
    manifest           BLOB NOT NULL,
    created_at         INTEGER NOT NULL,
    deleted_at         INTEGER,
    remove_at          INTEGER
) STRICT;

CREATE INDEX versions_node ON versions (node_id, seq);
CREATE INDEX versions_blob ON versions (blob_id);
CREATE INDEX versions_remove ON versions (remove_at) WHERE remove_at IS NOT NULL;

-- user_id is who uploads, owner_id whose quota holds the reservation. The id is
-- also the id of the blob that the upload becomes.
CREATE TABLE uploads (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    owner_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id     TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    version_id  TEXT NOT NULL UNIQUE,
    suite       TEXT NOT NULL,
    frame_count INTEGER NOT NULL,
    frame_size  INTEGER NOT NULL,
    stored_size INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX uploads_user ON uploads (user_id);
CREATE INDEX uploads_owner ON uploads (owner_id);
CREATE INDEX uploads_node ON uploads (node_id);
CREATE INDEX uploads_updated ON uploads (updated_at);

CREATE TABLE upload_frames (
    upload_id TEXT NOT NULL REFERENCES uploads (id) ON DELETE CASCADE,
    idx       INTEGER NOT NULL,
    sha256    BLOB NOT NULL,
    PRIMARY KEY (upload_id, idx)
) STRICT, WITHOUT ROWID;

-- node_id has no foreign key: the journal says that a node went away.
CREATE TABLE changes (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id  TEXT NOT NULL,
    op       TEXT NOT NULL,
    at       INTEGER NOT NULL
) STRICT;

CREATE INDEX changes_owner ON changes (owner_id, seq);

-- Files whose rows are gone, waiting to be unlinked. A crash cannot lose one.
CREATE TABLE file_removals (
    kind TEXT NOT NULL CHECK (kind IN ('blob', 'upload')),
    id   TEXT NOT NULL,
    PRIMARY KEY (kind, id)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER versions_ref AFTER INSERT ON versions
BEGIN
    UPDATE blobs SET ref_count = ref_count + 1 WHERE id = NEW.blob_id;
END;

CREATE TRIGGER versions_unref AFTER DELETE ON versions
BEGIN
    UPDATE blobs SET ref_count = ref_count - 1 WHERE id = OLD.blob_id;
END;

CREATE TRIGGER blobs_unreferenced AFTER UPDATE OF ref_count ON blobs
WHEN NEW.ref_count <= 0
BEGIN
    DELETE FROM blobs WHERE id = NEW.id;
END;

CREATE TRIGGER blobs_charge AFTER INSERT ON blobs
BEGIN
    UPDATE users SET used_bytes = used_bytes + NEW.size WHERE id = NEW.owner_id;
END;

CREATE TRIGGER blobs_release AFTER DELETE ON blobs
BEGIN
    UPDATE users SET used_bytes = used_bytes - OLD.size WHERE id = OLD.owner_id;
    INSERT OR IGNORE INTO file_removals (kind, id) VALUES ('blob', OLD.id);
END;

CREATE TRIGGER uploads_reserve AFTER INSERT ON uploads
BEGIN
    UPDATE users SET reserved_bytes = reserved_bytes + NEW.stored_size WHERE id = NEW.owner_id;
END;

CREATE TRIGGER uploads_release AFTER DELETE ON uploads
BEGIN
    UPDATE users SET reserved_bytes = reserved_bytes - OLD.stored_size WHERE id = OLD.owner_id;
    INSERT OR IGNORE INTO file_removals (kind, id) VALUES ('upload', OLD.id);
END;
