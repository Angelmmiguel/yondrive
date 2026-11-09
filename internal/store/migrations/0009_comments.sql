-- Comments, and the commenter role.
--
-- grants is rebuilt, as its role takes a new value. Nothing refers to it, and its
-- trigger and indexes come back as they were.

CREATE TABLE grants_new (
    id             TEXT PRIMARY KEY,
    node_id        TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    grantee_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    granter_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role           TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
    key_generation INTEGER NOT NULL,
    sealed_key     BLOB NOT NULL,
    signature      BLOB NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    read_at        INTEGER,
    UNIQUE (node_id, grantee_id)
) STRICT;

INSERT INTO grants_new (id, node_id, grantee_id, granter_id, role, key_generation, sealed_key, signature,
    created_at, updated_at, read_at)
SELECT id, node_id, grantee_id, granter_id, role, key_generation, sealed_key, signature,
    created_at, updated_at, read_at
FROM grants;

DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;
CREATE INDEX grants_grantee ON grants (grantee_id, id);
CREATE INDEX grants_granter ON grants (granter_id, id);

CREATE TRIGGER grants_revoked AFTER DELETE ON grants
WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.grantee_id)
BEGIN
    INSERT INTO changes (user_id, node_id, op, at) VALUES (OLD.grantee_id, OLD.node_id, 'revoked', unixepoch());
END;

-- Counts every change to a file's comments, so that a client that keeps anything
-- made from them, such as the search index, knows when to read them again.
ALTER TABLE nodes ADD COLUMN comment_seq INTEGER NOT NULL DEFAULT 0;

-- A comment is a record beside its file, never in it. The body and the anchor are
-- sealed under the node key of the generation each records, and signed: the body
-- by its author, the anchor by whoever last placed it. In no-encryption mode they
-- hold readable JSON and the signatures are empty. A thread is its first comment,
-- whose thread_id is its own id, and the replies that name it; only the first has
-- an anchor and a resolved state. Deleting it deletes the replies.
CREATE TABLE comments (
    seq               INTEGER PRIMARY KEY AUTOINCREMENT,
    id                TEXT NOT NULL UNIQUE,
    node_id           TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    thread_id         TEXT NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
    author_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key_generation    INTEGER NOT NULL,
    sealed_body       BLOB NOT NULL,
    signature         BLOB NOT NULL,
    anchor_generation INTEGER,
    sealed_anchor     BLOB,
    anchor_signature  BLOB,
    anchor_signer_id  TEXT,
    anchor_updated_at INTEGER,
    resolved_by       TEXT,
    resolved_at       INTEGER,
    created_at        INTEGER NOT NULL,
    edited_at         INTEGER,
    CHECK ((sealed_anchor IS NULL) = (anchor_generation IS NULL)),
    CHECK (sealed_anchor IS NULL OR thread_id = id),
    CHECK (resolved_at IS NULL OR thread_id = id)
) STRICT;

CREATE INDEX comments_node ON comments (node_id, seq);
CREATE INDEX comments_thread ON comments (thread_id);
CREATE INDEX comments_author ON comments (author_id);

-- New comments a user has not marked as read, one row per file: ids only. A row
-- for a file the user can no longer read stays out of the list until it goes.
CREATE TABLE comment_notices (
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    node_id    TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    comment_id TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    count      INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, node_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX comment_notices_newest ON comment_notices (user_id, created_at);
