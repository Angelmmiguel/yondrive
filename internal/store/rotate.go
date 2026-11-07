package store

import (
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
	// DropGrants names, by grantee, grants on the node that the owner's client
	// could not verify. They are deleted rather than sealed to.
	DropGrants []string
	// DropLinks names live links on the node whose key the owner's client could
	// not open. They are revoked.
	DropLinks []string
}

// RotateNode replaces a node's key in one transaction. A rotation must name every
// direct child, trashed ones too, every grant and every live link the node has
// now, or it fails with ErrRotateConflict and the client reads them again. A
// grant or link it drops counts as named. The
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
		if err := checkMetadataRoom(ctx, tx, n, r.SealedMetadata); err != nil {
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
	tags := map[string]string{}
	for rows.Next() {
		var id string
		var c current
		if err := rows.Scan(&id, &c.tag, &c.trashed); err != nil {
			_ = rows.Close()
			return fmt.Errorf("store: read children: %w", err)
		}
		have[id] = c
		if !c.trashed {
			tags[string(c.tag)] = id
		}
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return fmt.Errorf("store: read children: %w", err)
	}
	if len(have) != len(children) {
		return ErrRotateConflict
	}
	// New tags come from a new key, so one that matches a sibling's is a mistake.
	// Finding it here keeps it from the unique index halfway through the batch.
	seen := make(map[string]bool, len(children))
	for _, c := range children {
		child, ok := have[c.ID]
		if !ok || seen[c.ID] {
			return ErrRotateConflict
		}
		seen[c.ID] = true
		if child.trashed {
			continue
		}
		if holder, taken := tags[string(c.NameTag)]; taken && holder != c.ID {
			return ErrNameConflict
		}
		tags[string(c.NameTag)] = c.ID
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
	// A dropped grant is gone without a word to the journal: the owner's client is
	// what asked, and a "revoked" there would start another rotation.
	for _, grantee := range r.DropGrants {
		var ownerID string
		err := tx.QueryRowContext(ctx, `DELETE FROM grants WHERE node_id = ? AND grantee_id = ? AND key_generation = ?
			RETURNING granter_id`, nodeID, grantee, r.KeyGeneration).Scan(&ownerID)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrRotateConflict
		}
		if err != nil {
			return fmt.Errorf("store: drop grant: %w", err)
		}
		if err := dropLostUploads(ctx, tx, grantee, ownerID); err != nil {
			return err
		}
	}
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
	seen := make(map[string]bool, len(r.Links)+len(r.DropLinks))
	for _, id := range r.DropLinks {
		isLive, ok := have[id]
		if !ok || seen[id] {
			return ErrRotateConflict
		}
		seen[id] = true
		if !isLive {
			continue
		}
		live--
		if _, err := tx.ExecContext(ctx, "UPDATE links SET revoked_at = ? WHERE id = ?", now.Unix(), id); err != nil {
			return fmt.Errorf("store: revoke link: %w", err)
		}
	}
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
