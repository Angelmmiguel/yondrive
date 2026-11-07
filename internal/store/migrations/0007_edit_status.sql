-- Who has a file open in an editor, for the warning that someone else is editing.
-- A row is a heartbeat that holds until expires_at; it says nothing about content.

CREATE TABLE edit_status (
    node_id    TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, user_id)
) WITHOUT ROWID;

CREATE INDEX edit_status_expires ON edit_status (expires_at);
