package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// AuditEntry is one security event. It names what happened, who did it, to
// whom and from where; it never holds content or secrets.
type AuditEntry struct {
	At       time.Time
	Action   string
	ActorID  string
	TargetID string
	Remote   string
}

// AppendAudit records an event.
func (s *Store) AppendAudit(ctx context.Context, e AuditEntry) error {
	_, err := s.write.ExecContext(ctx,
		"INSERT INTO audit (at, action, actor_id, target_id, remote) VALUES (?, ?, nullif(?, ''), nullif(?, ''), nullif(?, ''))",
		e.At.Unix(), e.Action, e.ActorID, e.TargetID, e.Remote)
	if err != nil {
		return fmt.Errorf("store: append audit: %w", err)
	}
	return nil
}

// ListAudit returns the most recent events, newest first.
func (s *Store) ListAudit(ctx context.Context, limit int) ([]AuditEntry, error) {
	rows, err := s.read.QueryContext(ctx, `SELECT at, action, coalesce(actor_id, ''), coalesce(target_id, ''), coalesce(remote, '')
		FROM audit ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list audit: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var entries []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var at sql.NullInt64
		if err := rows.Scan(&at, &e.Action, &e.ActorID, &e.TargetID, &e.Remote); err != nil {
			return nil, fmt.Errorf("store: list audit: %w", err)
		}
		e.At = time.Unix(at.Int64, 0).UTC()
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list audit: %w", err)
	}
	return entries, nil
}
