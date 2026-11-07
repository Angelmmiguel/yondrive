package store

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"time"
)

// AuditEntry is one security event. It names what happened, who did it, to
// whom and from where; it never holds content or secrets.
type AuditEntry struct {
	ID       int64
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
	return s.ListAuditBefore(ctx, math.MaxInt64, limit)
}

// ListAuditBefore returns the events with an id below before, newest first.
func (s *Store) ListAuditBefore(ctx context.Context, before int64, limit int) ([]AuditEntry, error) {
	rows, err := s.read.QueryContext(ctx, `SELECT id, at, action, coalesce(actor_id, ''), coalesce(target_id, ''), coalesce(remote, '')
		FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?`, before, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list audit: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var entries []AuditEntry
	for rows.Next() {
		var e AuditEntry
		var at sql.NullInt64
		if err := rows.Scan(&e.ID, &at, &e.Action, &e.ActorID, &e.TargetID, &e.Remote); err != nil {
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

// TrimAudit removes up to limit events older than cutoff and returns how many.
func (s *Store) TrimAudit(ctx context.Context, cutoff time.Time, limit int) (int, error) {
	res, err := s.write.ExecContext(ctx,
		"DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE at < ? ORDER BY id LIMIT ?)", cutoff.Unix(), limit)
	if err != nil {
		return 0, fmt.Errorf("store: trim audit: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("store: trim audit: %w", err)
	}
	return int(n), nil
}
