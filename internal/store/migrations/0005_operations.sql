-- Keeping the audit trail and the change journal from growing for ever. A user's
-- journal_floor is the highest sequence number trimmed from their journal: a cursor
-- below it has missed something, and one at or above it has not.

ALTER TABLE users ADD COLUMN journal_floor INTEGER NOT NULL DEFAULT 0;

CREATE INDEX changes_at ON changes (at);
CREATE INDEX audit_at ON audit (at);
