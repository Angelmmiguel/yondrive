-- Devices: how a token was made and for which platform, and the pairings that
-- hand a device its token (and in end-to-end mode the master key) sealed, so
-- that the server carries only ciphertext (docs/CRYPTO.md section 22).

ALTER TABLE tokens ADD COLUMN platform TEXT;
ALTER TABLE tokens ADD COLUMN origin TEXT NOT NULL DEFAULT 'settings'
    CHECK (origin IN ('settings', 'pairing', 'login'));

-- A pairing belongs to the session or token that started it. Until it is
-- confirmed it ends with them (the triggers below); once confirmed it outlives
-- them, so that the device can still collect what the browser sealed, and the
-- link is cleared. device_public_key is the device's ephemeral X25519 key;
-- sealed_payload opens only on that device. token_id is set once confirmed, and
-- picked_up_at once the device has fetched the sealed payload.
CREATE TABLE pairings (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_hash       BLOB REFERENCES sessions (hash) ON DELETE SET NULL,
    creator_token_id   TEXT REFERENCES tokens (id) ON DELETE SET NULL,
    state              TEXT NOT NULL CHECK (state IN ('open', 'claimed', 'confirmed')),
    device_public_key  BLOB,
    device_name        TEXT,
    device_platform    TEXT,
    sealed_payload     BLOB,
    token_id           TEXT REFERENCES tokens (id) ON DELETE CASCADE,
    created_at         INTEGER NOT NULL,
    claimed_at         INTEGER,
    confirmed_at       INTEGER,
    picked_up_at       INTEGER,
    expires_at         INTEGER NOT NULL,
    CHECK (state = 'confirmed' OR (session_hash IS NULL) <> (creator_token_id IS NULL)),
    CHECK (session_hash IS NULL OR creator_token_id IS NULL),
    CHECK ((state = 'open') = (device_public_key IS NULL)),
    CHECK ((state = 'confirmed') = (sealed_payload IS NOT NULL)),
    CHECK ((state = 'confirmed') = (token_id IS NOT NULL)),
    CHECK (picked_up_at IS NULL OR state = 'confirmed')
) STRICT;

CREATE INDEX pairings_user ON pairings (user_id);
CREATE INDEX pairings_expiry ON pairings (expires_at);

-- An unconfirmed pairing ends with the session or token that started it, before
-- the link to it is cleared: it can never be confirmed by anyone else.
CREATE TRIGGER sessions_end_pairings BEFORE DELETE ON sessions
BEGIN
    DELETE FROM pairings WHERE session_hash = OLD.hash AND state <> 'confirmed';
END;

CREATE TRIGGER tokens_end_pairings BEFORE DELETE ON tokens
BEGIN
    DELETE FROM pairings WHERE creator_token_id = OLD.id AND state <> 'confirmed';
END;

-- A confirmed pairing that goes before its device collected the payload, however
-- it goes, takes its token with it: nobody holds that token's secret.
CREATE TRIGGER pairings_uncollected AFTER DELETE ON pairings
WHEN OLD.state = 'confirmed' AND OLD.picked_up_at IS NULL
BEGIN
    DELETE FROM tokens WHERE id = OLD.token_id;
END;
