package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Roles a grant can give.
const (
	RoleViewer = "viewer"
	RoleEditor = "editor"
)

// Errors of sharing. Callers match them with errors.Is.
var (
	// ErrGrantExists means the user already has a grant on the node.
	ErrGrantExists = errors.New("store: user already has a grant on the node")
	// ErrKeyGeneration means a write was sealed under a key that has been rotated.
	ErrKeyGeneration = errors.New("store: key generation has moved on")
	// ErrRotateConflict means a rotation does not cover what the node has now.
	ErrRotateConflict = errors.New("store: rotation does not match the node")
	// ErrMoveOutOfShare means an editor would move a node out of the shared subtree.
	ErrMoveOutOfShare = errors.New("store: move leaves the shared subtree")
	// ErrMoveAcrossOwners means the node and the new parent have different owners.
	ErrMoveAcrossOwners = errors.New("store: move crosses owners")
)

// Grant gives a user a role over a node and everything under it. SealedKey and
// Signature are opaque. The two names come from the users table.
type Grant struct {
	ID            string
	NodeID        string
	GranteeID     string
	GranteeName   string
	GranterID     string
	GranterName   string
	Role          string
	KeyGeneration int64
	SealedKey     []byte
	Signature     []byte
	CreatedAt     time.Time
	UpdatedAt     time.Time
	ReadAt        time.Time
}

const grantSelect = `SELECT g.id, g.node_id, g.grantee_id, ge.username, g.granter_id, gr.username, g.role, g.key_generation,
	g.sealed_key, g.signature, g.created_at, g.updated_at, g.read_at
	FROM grants g JOIN users ge ON ge.id = g.grantee_id JOIN users gr ON gr.id = g.granter_id `

func scanGrant(row interface{ Scan(...any) error }) (Grant, error) {
	var g Grant
	var created, updated int64
	var read sql.NullInt64
	err := row.Scan(&g.ID, &g.NodeID, &g.GranteeID, &g.GranteeName, &g.GranterID, &g.GranterName, &g.Role, &g.KeyGeneration,
		&g.SealedKey, &g.Signature, &created, &updated, &read)
	g.SealedKey, g.Signature = nonNil(g.SealedKey), nonNil(g.Signature)
	g.CreatedAt, g.UpdatedAt = time.Unix(created, 0).UTC(), time.Unix(updated, 0).UTC()
	g.ReadAt = fromNull(read)
	return g, err
}

func oneGrant(ctx context.Context, q querier, id string) (Grant, error) {
	g, err := scanGrant(q.QueryRowContext(ctx, grantSelect+"WHERE g.id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Grant{}, ErrNotFound
	}
	if err != nil {
		return Grant{}, fmt.Errorf("store: read grant: %w", err)
	}
	return g, nil
}

func listGrants(ctx context.Context, q querier, where string, args ...any) ([]Grant, error) {
	rows, err := q.QueryContext(ctx, grantSelect+where, args...)
	if err != nil {
		return nil, fmt.Errorf("store: list grants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Grant
	for rows.Next() {
		g, err := scanGrant(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list grants: %w", err)
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list grants: %w", err)
	}
	return out, nil
}

// GrantByID returns a grant, or ErrNotFound.
func (s *Store) GrantByID(ctx context.Context, id string) (Grant, error) {
	return oneGrant(ctx, s.read, id)
}

// CreateGrant adds a grant on a node, sealed under the key generation it names.
// A root holds the owner's own tags and cannot be shared, and neither can what is
// in the trash.
func (s *Store) CreateGrant(ctx context.Context, g Grant) (Grant, error) {
	var out Grant
	err := s.tx(ctx, func(tx *sql.Tx) error {
		n, err := oneNode(ctx, tx, "id = ?", g.NodeID)
		if err != nil {
			return err
		}
		if n.ParentID == "" {
			return ErrRootImmutable
		}
		if err := checkNotTrashed(ctx, tx, n.ID); err != nil {
			return err
		}
		if n.KeyGeneration != g.KeyGeneration {
			return ErrKeyGeneration
		}
		var exists int
		err = tx.QueryRowContext(ctx, "SELECT 1 FROM grants WHERE node_id = ? AND grantee_id = ?", g.NodeID, g.GranteeID).Scan(&exists)
		if err == nil {
			return ErrGrantExists
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: check grant: %w", err)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO grants (id, node_id, grantee_id, granter_id, role, key_generation,
			sealed_key, signature, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			g.ID, g.NodeID, g.GranteeID, g.GranterID, g.Role, g.KeyGeneration,
			nonNil(g.SealedKey), nonNil(g.Signature), g.CreatedAt.Unix(), g.CreatedAt.Unix())
		if err != nil {
			return fmt.Errorf("store: insert grant: %w", err)
		}
		if err := recordFor(ctx, tx, g.GranteeID, g.NodeID, OpGranted, g.CreatedAt); err != nil {
			return err
		}
		if err := recordFor(ctx, tx, n.OwnerID, g.NodeID, OpGranted, g.CreatedAt); err != nil {
			return err
		}
		out, err = oneGrant(ctx, tx, g.ID)
		return err
	})
	return out, err
}

// UpdateGrantRole changes the role of a grant, with the signature over the new
// one. An editor made a viewer loses the uploads they had going.
func (s *Store) UpdateGrantRole(ctx context.Context, id, role string, signature []byte, now time.Time) (Grant, error) {
	var out Grant
	err := s.tx(ctx, func(tx *sql.Tx) error {
		g, err := oneGrant(ctx, tx, id)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "UPDATE grants SET role = ?, signature = ?, updated_at = ? WHERE id = ?", role, nonNil(signature), now.Unix(), id)
		if err != nil {
			return fmt.Errorf("store: update grant: %w", err)
		}
		if err := recordFor(ctx, tx, g.GranteeID, g.NodeID, OpRoleChanged, now); err != nil {
			return err
		}
		if err := dropLostUploads(ctx, tx, g.GranteeID, g.GranterID); err != nil {
			return err
		}
		out, err = oneGrant(ctx, tx, id)
		return err
	})
	return out, err
}

// DeleteGrant removes a grant. A trigger tells the grantee through the journal,
// and uploads they can no longer finish stop holding the owner's quota.
func (s *Store) DeleteGrant(ctx context.Context, id string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		g, err := oneGrant(ctx, tx, id)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM grants WHERE id = ?", id); err != nil {
			return fmt.Errorf("store: delete grant: %w", err)
		}
		// The owner is told here, so that their client rotates the node key
		// whoever removed the grant. A grant that goes with its node or its
		// owner does not pass through here, so nothing doubles up.
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO changes (user_id, node_id, op, at) VALUES (?, ?, 'revoked', unixepoch())",
			g.GranterID, g.NodeID); err != nil {
			return fmt.Errorf("store: tell the owner: %w", err)
		}
		return dropLostUploads(ctx, tx, g.GranteeID, g.GranterID)
	})
}

// dropLostUploads forgets the uploads a user started on an owner's nodes that
// they can no longer write to.
func dropLostUploads(ctx context.Context, tx *sql.Tx, userID, ownerID string) error {
	rows, err := tx.QueryContext(ctx, "SELECT id, node_id FROM uploads WHERE user_id = ? AND owner_id = ?", userID, ownerID)
	if err != nil {
		return fmt.Errorf("store: list uploads: %w", err)
	}
	type upload struct{ id, node string }
	var uploads []upload
	for rows.Next() {
		var u upload
		if err := rows.Scan(&u.id, &u.node); err != nil {
			_ = rows.Close()
			return fmt.Errorf("store: list uploads: %w", err)
		}
		uploads = append(uploads, u)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return fmt.Errorf("store: list uploads: %w", err)
	}
	for _, u := range uploads {
		chain, err := lineageRoles(ctx, tx, userID, u.node)
		if err != nil {
			return err
		}
		editor := false
		for _, entry := range chain {
			editor = editor || entry.Role == RoleEditor
		}
		if editor {
			continue
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM uploads WHERE id = ?", u.id); err != nil {
			return fmt.Errorf("store: delete upload: %w", err)
		}
	}
	return nil
}

// ListGrantsByGranter returns a page of the grants a user has made, by id.
func (s *Store) ListGrantsByGranter(ctx context.Context, granterID, after string, limit int) ([]Grant, error) {
	return listGrants(ctx, s.read, "WHERE g.granter_id = ? AND g.id > ? ORDER BY g.id LIMIT ?", granterID, after, limit)
}

// ListGrantsForGrantee returns a page of the grants a user holds, by id.
func (s *Store) ListGrantsForGrantee(ctx context.Context, granteeID, after string, limit int) ([]Grant, error) {
	return listGrants(ctx, s.read, "WHERE g.grantee_id = ? AND g.id > ? ORDER BY g.id LIMIT ?", granteeID, after, limit)
}

// ListUnreadGrants returns the newest grants a user has not marked as read.
func (s *Store) ListUnreadGrants(ctx context.Context, granteeID string, limit int) ([]Grant, error) {
	return listGrants(ctx, s.read, "WHERE g.grantee_id = ? AND g.read_at IS NULL ORDER BY g.created_at DESC, g.id LIMIT ?", granteeID, limit)
}

// MarkGrantsRead marks a user's own grants as read: those named, or all of them
// if ids is nil.
func (s *Store) MarkGrantsRead(ctx context.Context, granteeID string, ids []string, now time.Time) error {
	query := "UPDATE grants SET read_at = ? WHERE grantee_id = ? AND read_at IS NULL"
	args := []any{now.Unix(), granteeID}
	if ids != nil {
		list, err := json.Marshal(ids)
		if err != nil {
			return fmt.Errorf("store: mark grants: %w", err)
		}
		query += " AND id IN (SELECT value FROM json_each(?))"
		args = append(args, string(list))
	}
	if _, err := s.write.ExecContext(ctx, query, args...); err != nil {
		return fmt.Errorf("store: mark grants: %w", err)
	}
	return nil
}

// LineageGrant is a grant on a node or on a folder above it.
type LineageGrant struct {
	Grant
	Depth int
}

// ListLineageGrants returns the grants on a node and on everything above it,
// nearest first.
func (s *Store) ListLineageGrants(ctx context.Context, nodeID string) ([]LineageGrant, error) {
	chain, err := lineage(ctx, s.read, nodeID)
	if err != nil {
		return nil, err
	}
	var out []LineageGrant
	for depth, a := range chain {
		grants, err := listGrants(ctx, s.read, "WHERE g.node_id = ? ORDER BY g.id", a.id)
		if err != nil {
			return nil, err
		}
		for _, g := range grants {
			out = append(out, LineageGrant{Grant: g, Depth: depth})
		}
	}
	return out, nil
}

// LineageEntry is a node, or a folder above it, as one user sees it: Role is the
// role of the user's own grant there, or empty.
type LineageEntry struct {
	NodeID  string
	Depth   int
	Trashed bool
	Role    string
}

// LineageRoles returns the node and everything above it, nearest first, with the
// grants a user holds on them. The walk stops at the deepest a tree can be.
func (s *Store) LineageRoles(ctx context.Context, userID, nodeID string) ([]LineageEntry, error) {
	return lineageRoles(ctx, s.read, userID, nodeID)
}

func lineageRoles(ctx context.Context, q querier, userID, nodeID string) ([]LineageEntry, error) {
	rows, err := q.QueryContext(ctx, `WITH RECURSIVE up (id, parent_id, trashed, depth) AS (
			SELECT id, parent_id, trashed_at IS NOT NULL, 0 FROM nodes WHERE id = ?
			UNION ALL
			SELECT n.id, n.parent_id, n.trashed_at IS NOT NULL, up.depth + 1
			FROM nodes n JOIN up ON n.id = up.parent_id WHERE up.depth <= ?
		) SELECT up.id, up.depth, up.trashed, coalesce(g.role, '')
		FROM up LEFT JOIN grants g ON g.node_id = up.id AND g.grantee_id = ? ORDER BY up.depth`, nodeID, MaxTreeDepth+1, userID)
	if err != nil {
		return nil, fmt.Errorf("store: read lineage: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []LineageEntry
	for rows.Next() {
		var e LineageEntry
		if err := rows.Scan(&e.NodeID, &e.Depth, &e.Trashed, &e.Role); err != nil {
			return nil, fmt.Errorf("store: read lineage: %w", err)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: read lineage: %w", err)
	}
	return out, nil
}

// NodeInTrash reports whether a node, or a folder above it, is in the trash.
func (s *Store) NodeInTrash(ctx context.Context, nodeID string) (bool, error) {
	err := checkNotTrashed(ctx, s.read, nodeID)
	if errors.Is(err, ErrNodeTrashed) {
		return true, nil
	}
	return false, err
}

// GrantRolesOn returns the role of the grant a user holds on each of the nodes
// that has one. It gives a page of children the roles only they add.
func (s *Store) GrantRolesOn(ctx context.Context, userID string, nodeIDs []string) (map[string]string, error) {
	list, err := json.Marshal(nodeIDs)
	if err != nil {
		return nil, fmt.Errorf("store: read grants: %w", err)
	}
	rows, err := s.read.QueryContext(ctx, `SELECT node_id, role FROM grants
		WHERE grantee_id = ? AND node_id IN (SELECT value FROM json_each(?))`, userID, string(list))
	if err != nil {
		return nil, fmt.Errorf("store: read grants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var id, role string
		if err := rows.Scan(&id, &role); err != nil {
			return nil, fmt.Errorf("store: read grants: %w", err)
		}
		out[id] = role
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: read grants: %w", err)
	}
	return out, nil
}
