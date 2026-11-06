-- Accounts and server state. The blobs in users are opaque to the server.

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- The encryption mode is written once. These triggers hold that even against
-- a bug in the code above this schema.
CREATE TRIGGER settings_mode_insert BEFORE INSERT ON settings
WHEN NEW.key = 'mode' AND EXISTS (SELECT 1 FROM settings WHERE key = 'mode')
BEGIN
    SELECT RAISE(ABORT, 'the encryption mode is immutable');
END;

CREATE TRIGGER settings_mode_update BEFORE UPDATE ON settings
WHEN OLD.key = 'mode' OR NEW.key = 'mode'
BEGIN
    SELECT RAISE(ABORT, 'the encryption mode is immutable');
END;

CREATE TRIGGER settings_mode_delete BEFORE DELETE ON settings
WHEN OLD.key = 'mode'
BEGIN
    SELECT RAISE(ABORT, 'the encryption mode is immutable');
END;

-- kdf and auth_key_hash are nullable for accounts that sign in through a
-- provider, which also use oidc_issuer and oidc_subject.
CREATE TABLE users (
    id                          TEXT PRIMARY KEY,
    username                    TEXT NOT NULL UNIQUE,
    email                       TEXT,
    role                        TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    quota_bytes                 INTEGER NOT NULL DEFAULT 0,
    kdf                         BLOB,
    auth_key_hash               BLOB,
    recovery_auth_key_hash      BLOB,
    wrapped_master_key          BLOB,
    wrapped_master_key_recovery BLOB,
    sealed_x25519               BLOB,
    sealed_ed25519              BLOB,
    public_key_x25519           BLOB,
    public_key_ed25519          BLOB,
    totp_secret                 BLOB,
    totp_enabled_at             INTEGER,
    totp_last_step              INTEGER NOT NULL DEFAULT 0,
    oidc_issuer                 TEXT,
    oidc_subject                TEXT,
    disabled_at                 INTEGER,
    created_at                  INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX users_email ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_oidc ON users (oidc_issuer, oidc_subject) WHERE oidc_issuer IS NOT NULL;

CREATE TABLE recovery_codes (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    hash    BLOB NOT NULL,
    PRIMARY KEY (user_id, hash)
) STRICT, WITHOUT ROWID;

CREATE TABLE sessions (
    hash        BLOB PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    absolute_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    hash         BLOB NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
) STRICT;

CREATE INDEX tokens_user ON tokens (user_id);

CREATE TABLE invites (
    id          TEXT PRIMARY KEY,
    token_hash  BLOB NOT NULL UNIQUE,
    email       TEXT,
    role        TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    quota_bytes INTEGER,
    created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    used_by     TEXT REFERENCES users (id) ON DELETE SET NULL
) STRICT;

CREATE TABLE password_resets (
    hash       BLOB PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX password_resets_user ON password_resets (user_id);

-- No foreign keys: the trail outlives the users it mentions.
CREATE TABLE audit (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    action    TEXT NOT NULL,
    actor_id  TEXT,
    target_id TEXT,
    remote    TEXT
) STRICT;
