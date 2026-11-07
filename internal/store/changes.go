package store

import (
	"context"
	"database/sql"
	"errors"
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

// JournalFloor returns the highest sequence number trimmed from a user's journal.
func (s *Store) JournalFloor(ctx context.Context, userID string) (int64, error) {
	var floor int64
	err := s.read.QueryRowContext(ctx, "SELECT journal_floor FROM users WHERE id = ?", userID).Scan(&floor)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("store: read journal floor: %w", err)
	}
	return floor, nil
}

// TrimChanges removes up to limit journal entries older than cutoff, raising the
// floor of each journal they leave, and returns how many it removed. The floor is
// per user: someone else's old entries must not make a quiet user's cursor expire.
func (s *Store) TrimChanges(ctx context.Context, cutoff time.Time, limit int) (int, error) {
	var removed int
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var upto sql.NullInt64
		err := tx.QueryRowContext(ctx,
			"SELECT max(seq) FROM (SELECT seq FROM changes WHERE at < ? ORDER BY seq LIMIT ?)", cutoff.Unix(), limit).Scan(&upto)
		if err != nil {
			return fmt.Errorf("store: trim changes: %w", err)
		}
		if !upto.Valid {
			return nil
		}
		at := cutoff.Unix()
		_, err = tx.ExecContext(ctx, `UPDATE users SET journal_floor = max(journal_floor,
				(SELECT max(seq) FROM changes WHERE user_id = users.id AND seq <= ? AND at < ?))
			WHERE id IN (SELECT user_id FROM changes WHERE seq <= ? AND at < ?)`, upto.Int64, at, upto.Int64, at)
		if err != nil {
			return fmt.Errorf("store: raise journal floor: %w", err)
		}
		res, err := tx.ExecContext(ctx, "DELETE FROM changes WHERE seq <= ? AND at < ?", upto.Int64, at)
		if err != nil {
			return fmt.Errorf("store: trim changes: %w", err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return fmt.Errorf("store: trim changes: %w", err)
		}
		removed = int(n)
		return nil
	})
	return removed, err
}
