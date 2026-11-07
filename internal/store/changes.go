package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Change is one entry of the journal. Sequence numbers grow with every commit
// and are never reused, so a client that stored one misses nothing.
type Change struct {
	Seq    int64
	NodeID string
	Op     string
	At     time.Time
}

func recordChange(ctx context.Context, tx *sql.Tx, ownerID, nodeID, op string, at time.Time) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO changes (owner_id, node_id, op, at) VALUES (?, ?, ?, ?)",
		ownerID, nodeID, op, at.Unix())
	if err != nil {
		return fmt.Errorf("store: record change: %w", err)
	}
	return nil
}

// ListChanges returns a page of the journal of the nodes a user can reach, in
// order, after the sequence number given. Today those are the nodes they own.
func (s *Store) ListChanges(ctx context.Context, userID string, after int64, limit int) ([]Change, error) {
	rows, err := s.read.QueryContext(ctx,
		"SELECT seq, node_id, op, at FROM changes WHERE owner_id = ? AND seq > ? ORDER BY seq LIMIT ?", userID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list changes: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Change
	for rows.Next() {
		var c Change
		var at int64
		if err := rows.Scan(&c.Seq, &c.NodeID, &c.Op, &at); err != nil {
			return nil, fmt.Errorf("store: list changes: %w", err)
		}
		c.At = time.Unix(at, 0).UTC()
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list changes: %w", err)
	}
	return out, nil
}
