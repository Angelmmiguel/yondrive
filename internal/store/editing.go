package store

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Editor is someone with a live heartbeat on a node.
type Editor struct {
	UserID   string
	Username string
	// Since is when their current run of heartbeats began.
	Since time.Time
}

// MarkEditing records that a user has a node open in an editor until expires.
// A heartbeat after the previous one lapsed starts a new run.
func (s *Store) MarkEditing(ctx context.Context, nodeID, userID string, now, expires time.Time) error {
	_, err := s.write.ExecContext(ctx, `INSERT INTO edit_status (node_id, user_id, started_at, expires_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (node_id, user_id) DO UPDATE SET
			started_at = CASE WHEN edit_status.expires_at <= ? THEN excluded.started_at ELSE edit_status.started_at END,
			expires_at = excluded.expires_at`,
		nodeID, userID, now.Unix(), expires.Unix(), now.Unix())
	if err != nil {
		return fmt.Errorf("store: mark editing: %w", err)
	}
	return nil
}

// Editors lists who has a live heartbeat on a node, oldest first.
func (s *Store) Editors(ctx context.Context, nodeID string, now time.Time) ([]Editor, error) {
	rows, err := s.read.QueryContext(ctx, `SELECT e.user_id, u.username, e.started_at
		FROM edit_status e JOIN users u ON u.id = e.user_id
		WHERE e.node_id = ? AND e.expires_at > ?
		ORDER BY e.started_at, e.user_id`, nodeID, now.Unix())
	if err != nil {
		return nil, fmt.Errorf("store: list editors: %w", err)
	}
	var out []Editor
	for rows.Next() {
		var e Editor
		var since int64
		if err := rows.Scan(&e.UserID, &e.Username, &since); err != nil {
			_ = rows.Close()
			return nil, fmt.Errorf("store: list editors: %w", err)
		}
		e.Since = time.Unix(since, 0).UTC()
		out = append(out, e)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return nil, fmt.Errorf("store: list editors: %w", err)
	}
	return out, nil
}

// RemoveExpiredEditing drops heartbeats that lapsed before now.
func (s *Store) RemoveExpiredEditing(ctx context.Context, now time.Time) error {
	if _, err := s.write.ExecContext(ctx, "DELETE FROM edit_status WHERE expires_at <= ?", now.Unix()); err != nil {
		return fmt.Errorf("store: remove expired editing: %w", err)
	}
	return nil
}
