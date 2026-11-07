package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// RotatedChild is a direct child's key wrapped under the node's new key, and the
// tag of its name under that key.
type RotatedChild struct {
	ID         string
	WrappedKey []byte
	NameTag    []byte
}

// RotatedGrant is a grant on the node, resealed to its grantee and signed anew.
type RotatedGrant struct {
	GranteeID string
	SealedKey []byte
	Signature []byte
}

// RotatedLink is a live link on the node, resealed under its link key.
type RotatedLink struct {
	ID        string
	SealedKey []byte
}

// Rotation is everything that changes when a node's key does.
type Rotation struct {
	KeyGeneration       int64
	ParentKeyGeneration int64
	WrappedKey          []byte
	PreviousKey         []byte
	SealedMetadata      []byte
	Children            []RotatedChild
	Grants              []RotatedGrant
	Links               []RotatedLink
}

// RotateNode replaces a node's key in one transaction. A rotation must name every
// direct child, trashed ones too, every grant and every live link the node has
// now, or it fails with ErrRotateConflict and the client reads them again. The
// thumbnail goes, since it is sealed under the old key and has no generation of
// its own, and a client can make another.
func (s *Store) RotateNode(ctx context.Context, id string, r Rotation, now time.Time) (Node, error) {
	return s.updateNode(ctx, id, OpRotated, now, func(tx *sql.Tx, n Node) (bool, error) {
		if n.ParentID == "" {
			return false, ErrRootImmutable
		}
		if n.KeyGeneration != r.KeyGeneration {
			return false, ErrKeyGeneration
		}
		if err := checkGeneration(ctx, tx, n.ParentID, &r.ParentKeyGeneration); err != nil {
			return false, err
		}
		if err := rewrapChildren(ctx, tx, id, r.Children); err != nil {
			return false, err
		}
		if err := resealGrants(ctx, tx, id, r, now); err != nil {
			return false, err
		}
		if err := resealLinks(ctx, tx, id, r, now); err != nil {
			return false, err
		}
		if len(r.PreviousKey) > 0 {
			_, err := tx.ExecContext(ctx, "INSERT INTO node_key_history (node_id, generation, sealed_key, created_at) VALUES (?, ?, ?, ?)",
				id, n.KeyGeneration, r.PreviousKey, now.Unix())
			if err != nil {
				return false, fmt.Errorf("store: record key: %w", err)
			}
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM blobs WHERE node_id = ? AND kind = ?", id, BlobThumb); err != nil {
			return false, fmt.Errorf("store: drop thumbnail: %w", err)
		}
		_, err := tx.ExecContext(ctx, "UPDATE nodes SET key_generation = key_generation + 1, wrapped_key = ?, sealed_metadata = ? WHERE id = ?",
			nonNil(r.WrappedKey), r.SealedMetadata, id)
		if err != nil {
			return false, fmt.Errorf("store: rotate node: %w", err)
		}
		return true, nil
	})
}

func rewrapChildren(ctx context.Context, tx *sql.Tx, parentID string, children []RotatedChild) error {
	rows, err := tx.QueryContext(ctx, "SELECT id, name_tag, trashed_at IS NOT NULL FROM nodes WHERE parent_id = ?", parentID)
	if err != nil {
		return fmt.Errorf("store: read children: %w", err)
	}
	type current struct {
		tag     []byte
		trashed bool
	}
	have := map[string]current{}
	for rows.Next() {
		var id string
		var c current
		if err := rows.Scan(&id, &c.tag, &c.trashed); err != nil {
			_ = rows.Close()
			return fmt.Errorf("store: read children: %w", err)
		}
		have[id] = c
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return fmt.Errorf("store: read children: %w", err)
	}
	if len(have) != len(children) {
		return ErrRotateConflict
	}
	// New tags come from a new key. One that matches a sibling's is a mistake, and
	// finding it here keeps it from the unique index halfway through the batch.
	seen := make(map[string]bool, len(children))
	for _, c := range children {
		if _, ok := have[c.ID]; !ok || seen[c.ID] {
			return ErrRotateConflict
		}
		seen[c.ID] = true
		if have[c.ID].trashed {
			continue
		}
		for id, other := range have {
			if id != c.ID && !other.trashed && bytes.Equal(other.tag, c.NameTag) {
				return ErrNameConflict
			}
		}
	}
	update, err := tx.PrepareContext(ctx, "UPDATE nodes SET wrapped_key = ?, name_tag = ? WHERE id = ?")
	if err != nil {
		return fmt.Errorf("store: rewrap children: %w", err)
	}
	defer func() { _ = update.Close() }()
	for _, c := range children {
		if _, err := update.ExecContext(ctx, nonNil(c.WrappedKey), c.NameTag, c.ID); err != nil {
			return fmt.Errorf("store: rewrap child: %w", err)
		}
	}
	return nil
}

func resealGrants(ctx context.Context, tx *sql.Tx, nodeID string, r Rotation, now time.Time) error {
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM grants WHERE node_id = ?", nodeID).Scan(&count); err != nil {
		return fmt.Errorf("store: count grants: %w", err)
	}
	if count != len(r.Grants) {
		return ErrRotateConflict
	}
	for _, g := range r.Grants {
		res, err := tx.ExecContext(ctx, `UPDATE grants SET sealed_key = ?, signature = ?, key_generation = ?, updated_at = ?
			WHERE node_id = ? AND grantee_id = ? AND key_generation = ?`,
			nonNil(g.SealedKey), nonNil(g.Signature), r.KeyGeneration+1, now.Unix(), nodeID, g.GranteeID, r.KeyGeneration)
		if err != nil {
			return fmt.Errorf("store: reseal grant: %w", err)
		}
		// A repeated grantee finds its row already at the new generation.
		if err := requireRow(res, ErrRotateConflict); err != nil {
			return err
		}
	}
	return nil
}

// resealLinks ignores a link that has stopped being live, which can happen
// between the client reading the list and this transaction: its key is never
// served again. Any other link it does not expect is a conflict.
func resealLinks(ctx context.Context, tx *sql.Tx, nodeID string, r Rotation, now time.Time) error {
	rows, err := tx.QueryContext(ctx, `SELECT id, revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
		FROM links WHERE node_id = ?`, now.Unix(), nodeID)
	if err != nil {
		return fmt.Errorf("store: read links: %w", err)
	}
	have := map[string]bool{}
	live := 0
	for rows.Next() {
		var id string
		var isLive bool
		if err := rows.Scan(&id, &isLive); err != nil {
			_ = rows.Close()
			return fmt.Errorf("store: read links: %w", err)
		}
		have[id] = isLive
		if isLive {
			live++
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return fmt.Errorf("store: read links: %w", err)
	}
	seen := make(map[string]bool, len(r.Links))
	for _, l := range r.Links {
		isLive, ok := have[l.ID]
		if !ok || seen[l.ID] {
			return ErrRotateConflict
		}
		seen[l.ID] = true
		if !isLive {
			continue
		}
		live--
		_, err := tx.ExecContext(ctx, "UPDATE links SET sealed_key = ?, key_generation = ? WHERE id = ?",
			nonNil(l.SealedKey), r.KeyGeneration+1, l.ID)
		if err != nil {
			return fmt.Errorf("store: reseal link: %w", err)
		}
	}
	if live != 0 {
		return ErrRotateConflict
	}
	return nil
}
