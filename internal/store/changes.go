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

// recordChange adds an entry to the journal of the node's owner, and of everyone
// with a grant on the node or above it.
func recordChange(ctx context.Context, tx *sql.Tx, ownerID, nodeID, op string, at time.Time) error {
	if err := recordFor(ctx, tx, ownerID, nodeID, op, at); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO changes (user_id, node_id, op, at)
		WITH RECURSIVE up (id, parent_id, depth) AS (
			SELECT id, parent_id, 0 FROM nodes WHERE id = ?
			UNION ALL
			SELECT n.id, n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.parent_id WHERE up.depth <= ?
		) SELECT DISTINCT g.grantee_id, ?, ?, ? FROM up JOIN grants g ON g.node_id = up.id`,
		nodeID, MaxTreeDepth+1, nodeID, op, at.Unix())
	if err != nil {
		return fmt.Errorf("store: record change: %w", err)
	}
	return nil
}

func recordFor(ctx context.Context, tx *sql.Tx, userID, nodeID, op string, at time.Time) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO changes (user_id, node_id, op, at) VALUES (?, ?, ?, ?)", userID, nodeID, op, at.Unix())
	if err != nil {
		return fmt.Errorf("store: record change: %w", err)
	}
	return nil
}

// recordBelow tells whoever holds a grant under a node, who cannot see the node
// from where they are, that what happened to it happened to what they hold.
func recordBelow(ctx context.Context, tx *sql.Tx, ownerID, nodeID, op string, at time.Time) error {
	var shares int
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM grants WHERE granter_id = ?)", ownerID).Scan(&shares); err != nil {
		return fmt.Errorf("store: read grants: %w", err)
	}
	if shares == 0 {
		return nil
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO changes (user_id, node_id, op, at)
		WITH RECURSIVE down (id, depth) AS (
			SELECT id, 0 FROM nodes WHERE parent_id = ?
			UNION ALL
			SELECT n.id, down.depth + 1 FROM nodes n JOIN down ON n.parent_id = down.id WHERE down.depth <= ?
		) SELECT g.grantee_id, g.node_id, ?, ? FROM down JOIN grants g ON g.node_id = down.id`,
		nodeID, MaxTreeDepth+1, op, at.Unix())
	if err != nil {
		return fmt.Errorf("store: record change: %w", err)
	}
	return nil
}

// ListChanges returns a page of a user's journal, in order, after the sequence
// number given: what happened to their nodes and to those shared with them.
func (s *Store) ListChanges(ctx context.Context, userID string, after int64, limit int) ([]Change, error) {
	rows, err := s.read.QueryContext(ctx,
		"SELECT seq, node_id, op, at FROM changes WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT ?", userID, after, limit)
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
