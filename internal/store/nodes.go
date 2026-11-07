package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"time"
)

// Kinds of node.
const (
	KindFile   = "file"
	KindFolder = "folder"
)

// Operations in the change journal.
const (
	OpCreated        = "created"
	OpUpdated        = "updated"
	OpMoved          = "moved"
	OpTrashed        = "trashed"
	OpRestored       = "restored"
	OpPurged         = "purged"
	OpRemoved        = "removed"
	OpVersion        = "version"
	OpVersionDeleted = "version_deleted"
	OpThumbnail      = "thumbnail"
	OpGranted        = "granted"
	OpRoleChanged    = "role_changed"
	OpRevoked        = "revoked"
	OpRotated        = "rotated"
)

// MaxTreeDepth is how deep a tree may get. A purge relies on foreign key
// cascades, which SQLite limits to 1000 levels; a deeper tree could never be
// deleted, and neither could its owner.
const MaxTreeDepth = 256

// Errors of the drive. Callers match them with errors.Is.
var (
	// ErrIDTaken means a client-generated id is already in use.
	ErrIDTaken = errors.New("store: id is taken")
	// ErrNameConflict means a sibling that is not in the trash has the name tag.
	ErrNameConflict = errors.New("store: name tag exists in this folder")
	// ErrNotFolder means the parent is a file.
	ErrNotFolder = errors.New("store: parent is not a folder")
	// ErrNotFile means the node is a folder, which holds no content.
	ErrNotFile = errors.New("store: node is not a file")
	// ErrMoveCycle means a node would move into its own subtree.
	ErrMoveCycle = errors.New("store: move would create a cycle")
	// ErrTreeTooDeep means the operation would exceed MaxTreeDepth.
	ErrTreeTooDeep = errors.New("store: tree is too deep")
	// ErrRootImmutable means the operation does not apply to a root node.
	ErrRootImmutable = errors.New("store: a root node cannot do this")
	// ErrNodeTrashed means the node, or a folder above it, is in the trash.
	ErrNodeTrashed = errors.New("store: node is in the trash")
	// ErrParentTrashed means the parent, or a folder above it, is in the trash.
	ErrParentTrashed = errors.New("store: parent is in the trash")
	// ErrNotTrashed means the node is not itself in the trash.
	ErrNotTrashed = errors.New("store: node is not in the trash")
)

// Node is a file or folder. The metadata, wrapped key and name tag are opaque.
// A zero time means that the state it records does not hold.
type Node struct {
	ID             string
	OwnerID        string
	ParentID       string
	Kind           string
	Suite          string
	SealedMetadata []byte
	WrappedKey     []byte
	NameTag        []byte
	CurrentVersion string
	ThumbBlobID    string
	KeyGeneration  int64
	TrashedAt      time.Time
	PurgedAt       time.Time
	RemoveAt       time.Time
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

const nodeColumns = `id, owner_id, coalesce(parent_id, ''), kind, suite, sealed_metadata, wrapped_key, name_tag,
	coalesce(current_version, ''),
	coalesce((SELECT b.id FROM blobs b WHERE b.node_id = nodes.id AND b.kind = 'thumb'), ''),
	key_generation, trashed_at, purged_at, remove_at, created_at, updated_at`

func scanNode(row interface{ Scan(...any) error }) (Node, error) {
	var n Node
	var trashed, purged, remove sql.NullInt64
	var created, updated int64
	err := row.Scan(&n.ID, &n.OwnerID, &n.ParentID, &n.Kind, &n.Suite, &n.SealedMetadata, &n.WrappedKey, &n.NameTag,
		&n.CurrentVersion, &n.ThumbBlobID, &n.KeyGeneration, &trashed, &purged, &remove, &created, &updated)
	n.SealedMetadata, n.WrappedKey = nonNil(n.SealedMetadata), nonNil(n.WrappedKey)
	n.TrashedAt, n.PurgedAt, n.RemoveAt = fromNull(trashed), fromNull(purged), fromNull(remove)
	n.CreatedAt, n.UpdatedAt = time.Unix(created, 0).UTC(), time.Unix(updated, 0).UTC()
	return n, err
}

func fromNull(v sql.NullInt64) time.Time {
	if !v.Valid {
		return time.Time{}
	}
	return time.Unix(v.Int64, 0).UTC()
}

// querier is what a read needs: the read pool, or a transaction that must see
// its own writes.
type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func oneNode(ctx context.Context, q querier, where string, arg string) (Node, error) {
	n, err := scanNode(q.QueryRowContext(ctx, "SELECT "+nodeColumns+" FROM nodes WHERE "+where, arg))
	if errors.Is(err, sql.ErrNoRows) {
		return Node{}, ErrNotFound
	}
	if err != nil {
		return Node{}, fmt.Errorf("store: read node: %w", err)
	}
	return n, nil
}

// NodeByID returns a node, or ErrNotFound.
func (s *Store) NodeByID(ctx context.Context, id string) (Node, error) {
	return oneNode(ctx, s.read, "id = ?", id)
}

// RootNode returns a user's root node, or ErrNotFound if they have none yet.
func (s *Store) RootNode(ctx context.Context, ownerID string) (Node, error) {
	return oneNode(ctx, s.read, "owner_id = ? AND parent_id IS NULL", ownerID)
}

// CreateRoot adds a user's root node. If two devices race, the first wins, and
// the second gets the node that won with created false.
func (s *Store) CreateRoot(ctx context.Context, n Node) (_ Node, created bool, _ error) {
	var out Node
	err := s.tx(ctx, func(tx *sql.Tx) error {
		existing, err := oneNode(ctx, tx, "owner_id = ? AND parent_id IS NULL", n.OwnerID)
		if err == nil {
			out = existing
			return nil
		}
		if !errors.Is(err, ErrNotFound) {
			return err
		}
		n.Kind, n.ParentID, n.NameTag = KindFolder, "", nil
		if err := insertNode(ctx, tx, n); err != nil {
			return err
		}
		created = true
		out, err = oneNode(ctx, tx, "id = ?", n.ID)
		return err
	})
	return out, created, err
}

// CreateNode adds a file or folder under a folder of the same owner.
// parentGeneration is the generation of the parent's key the client wrapped the
// node's under: nil asks for no check.
func (s *Store) CreateNode(ctx context.Context, n Node, parentGeneration *int64) (Node, error) {
	var out Node
	err := s.tx(ctx, func(tx *sql.Tx) error {
		parent, err := oneNode(ctx, tx, "id = ?", n.ParentID)
		if err != nil {
			return err
		}
		if parent.OwnerID != n.OwnerID {
			return ErrNotFound
		}
		if parentGeneration != nil && *parentGeneration != parent.KeyGeneration {
			return ErrKeyGeneration
		}
		if err := checkParent(ctx, tx, parent, ""); err != nil {
			return err
		}
		if err := checkNameFree(ctx, tx, n.ParentID, n.NameTag, ""); err != nil {
			return err
		}
		if err := insertNode(ctx, tx, n); err != nil {
			return err
		}
		out, err = oneNode(ctx, tx, "id = ?", n.ID)
		return err
	})
	return out, err
}

func insertNode(ctx context.Context, tx *sql.Tx, n Node) error {
	var exists int
	err := tx.QueryRowContext(ctx, "SELECT 1 FROM nodes WHERE id = ?", n.ID).Scan(&exists)
	if err == nil {
		return ErrIDTaken
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("store: check node id: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO nodes (id, owner_id, parent_id, kind, suite, sealed_metadata,
		wrapped_key, name_tag, created_at, updated_at) VALUES (?, ?, nullif(?, ''), ?, ?, ?, ?, ?, ?, ?)`,
		n.ID, n.OwnerID, n.ParentID, n.Kind, n.Suite, nonNil(n.SealedMetadata), nonNil(n.WrappedKey), n.NameTag,
		n.CreatedAt.Unix(), n.CreatedAt.Unix())
	if err != nil {
		return fmt.Errorf("store: insert node: %w", err)
	}
	return recordChange(ctx, tx, n.OwnerID, n.ID, OpCreated, n.CreatedAt)
}

// nonNil keeps an empty blob, which is what a key is in the no-encryption mode,
// from becoming NULL on its way in or null on its way out.
func nonNil(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}

type ancestor struct {
	id      string
	trashed bool
}

// lineage returns the node and everything above it, nearest first. Writes are
// serialised, so inside a transaction it cannot change.
func lineage(ctx context.Context, q querier, id string) ([]ancestor, error) {
	rows, err := q.QueryContext(ctx, `WITH RECURSIVE up (id, parent_id, trashed, depth) AS (
			SELECT id, parent_id, trashed_at IS NOT NULL, 0 FROM nodes WHERE id = ?
			UNION ALL
			SELECT n.id, n.parent_id, n.trashed_at IS NOT NULL, up.depth + 1
			FROM nodes n JOIN up ON n.id = up.parent_id WHERE up.depth <= ?
		) SELECT id, trashed FROM up ORDER BY depth`, id, MaxTreeDepth+1)
	if err != nil {
		return nil, fmt.Errorf("store: read lineage: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []ancestor
	for rows.Next() {
		var a ancestor
		if err := rows.Scan(&a.id, &a.trashed); err != nil {
			return nil, fmt.Errorf("store: read lineage: %w", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: read lineage: %w", err)
	}
	return out, nil
}

// checkParent refuses a parent that cannot take a child. When moving names the
// node being moved, it also refuses a move into its own subtree and one that
// would take the subtree too deep.
func checkParent(ctx context.Context, q querier, parent Node, moving string) error {
	if parent.Kind != KindFolder {
		return ErrNotFolder
	}
	chain, err := lineage(ctx, q, parent.ID)
	if err != nil {
		return err
	}
	if moving != "" && slices.ContainsFunc(chain, func(a ancestor) bool { return a.id == moving }) {
		return ErrMoveCycle
	}
	if slices.ContainsFunc(chain, func(a ancestor) bool { return a.trashed }) {
		return ErrParentTrashed
	}
	height := 0
	if moving != "" {
		if height, err = subtreeHeight(ctx, q, moving); err != nil {
			return err
		}
	}
	if len(chain)+height > MaxTreeDepth {
		return ErrTreeTooDeep
	}
	return nil
}

func subtreeHeight(ctx context.Context, q querier, id string) (int, error) {
	var height int
	err := q.QueryRowContext(ctx, `WITH RECURSIVE down (id, depth) AS (
			SELECT id, 0 FROM nodes WHERE id = ?
			UNION ALL
			SELECT n.id, down.depth + 1 FROM nodes n JOIN down ON n.parent_id = down.id WHERE down.depth <= ?
		) SELECT max(depth) FROM down`, id, MaxTreeDepth+1).Scan(&height)
	if err != nil {
		return 0, fmt.Errorf("store: read subtree: %w", err)
	}
	return height, nil
}

func checkNameFree(ctx context.Context, q querier, parentID string, tag []byte, except string) error {
	var exists int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM nodes
		WHERE parent_id = ? AND name_tag = ? AND trashed_at IS NULL AND id <> ?`, parentID, tag, except).Scan(&exists)
	if err == nil {
		return ErrNameConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("store: check name: %w", err)
	}
	return nil
}

// checkNotTrashed refuses a node that is in the trash itself or under a folder
// that is.
func checkNotTrashed(ctx context.Context, q querier, id string) error {
	chain, err := lineage(ctx, q, id)
	if err != nil {
		return err
	}
	for _, a := range chain {
		if a.trashed {
			return ErrNodeTrashed
		}
	}
	return nil
}

// ListChildren returns a page of the children of a folder that are not in the
// trash, ordered by id, starting after the id given.
func (s *Store) ListChildren(ctx context.Context, parentID, after string, limit int) ([]Node, error) {
	return s.listNodes(ctx, "parent_id = ? AND trashed_at IS NULL AND id > ? ORDER BY id LIMIT ?", parentID, after, limit)
}

// ListTrash returns a page of a user's nodes in the trash, ordered by id.
// Children of a folder in the trash are not among them unless they were trashed
// on their own.
func (s *Store) ListTrash(ctx context.Context, ownerID, after string, limit int) ([]Node, error) {
	return s.listNodes(ctx, "owner_id = ? AND trashed_at IS NOT NULL AND id > ? ORDER BY id LIMIT ?", ownerID, after, limit)
}

func (s *Store) listNodes(ctx context.Context, where string, args ...any) ([]Node, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT "+nodeColumns+" FROM nodes WHERE "+where, args...) //nolint:gosec // where is a constant in this file
	if err != nil {
		return nil, fmt.Errorf("store: list nodes: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var nodes []Node
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list nodes: %w", err)
		}
		nodes = append(nodes, n)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list nodes: %w", err)
	}
	return nodes, nil
}

// updateNode runs change inside a transaction over the node and, if it reports a
// change, stamps and journals it. It returns the node as it then is.
func (s *Store) updateNode(ctx context.Context, id string, op string, now time.Time, change func(*sql.Tx, Node) (bool, error)) (Node, error) {
	var out Node
	err := s.tx(ctx, func(tx *sql.Tx) error {
		n, err := oneNode(ctx, tx, "id = ?", id)
		if err != nil {
			return err
		}
		changed, err := change(tx, n)
		if err != nil {
			return err
		}
		if changed {
			if _, err := tx.ExecContext(ctx, "UPDATE nodes SET updated_at = ? WHERE id = ?", now.Unix(), id); err != nil {
				return fmt.Errorf("store: update node: %w", err)
			}
			if err := recordChange(ctx, tx, n.OwnerID, id, op, now); err != nil {
				return err
			}
		}
		out, err = oneNode(ctx, tx, "id = ?", id)
		return err
	})
	return out, err
}

// KeyCheck names the key generations a client sealed a write under. Nil asks for
// no check.
type KeyCheck struct {
	Node   *int64
	Parent *int64
}

// checkGeneration refuses a write sealed under a key that has since been rotated.
func checkGeneration(ctx context.Context, q querier, id string, want *int64) error {
	if want == nil {
		return nil
	}
	var have int64
	if err := q.QueryRowContext(ctx, "SELECT key_generation FROM nodes WHERE id = ?", id).Scan(&have); err != nil {
		return fmt.Errorf("store: read key generation: %w", err)
	}
	if have != *want {
		return ErrKeyGeneration
	}
	return nil
}

// UpdateNode replaces a node's metadata and, for a rename, its name tag. A root
// has no tag, and the tag of a node under the trash is checked again on restore.
func (s *Store) UpdateNode(ctx context.Context, id string, metadata, nameTag []byte, check KeyCheck, now time.Time) (Node, error) {
	return s.updateNode(ctx, id, OpUpdated, now, func(tx *sql.Tx, n Node) (bool, error) {
		if err := checkNotTrashed(ctx, tx, id); err != nil {
			return false, err
		}
		if err := checkGeneration(ctx, tx, id, check.Node); err != nil {
			return false, err
		}
		if n.ParentID != "" {
			if err := checkGeneration(ctx, tx, n.ParentID, check.Parent); err != nil {
				return false, err
			}
		}
		if nameTag != nil {
			if n.ParentID == "" {
				return false, ErrRootImmutable
			}
			if err := checkNameFree(ctx, tx, n.ParentID, nameTag, id); err != nil {
				return false, err
			}
			if _, err := tx.ExecContext(ctx, "UPDATE nodes SET name_tag = ? WHERE id = ?", nameTag, id); err != nil {
				return false, fmt.Errorf("store: update name tag: %w", err)
			}
		}
		if metadata != nil {
			if _, err := tx.ExecContext(ctx, "UPDATE nodes SET sealed_metadata = ? WHERE id = ?", metadata, id); err != nil {
				return false, fmt.Errorf("store: update metadata: %w", err)
			}
		}
		return nameTag != nil || metadata != nil, nil
	})
}

// MoveGuard is what a move must hold to inside its transaction, since an owner
// may be moving the same folders about meanwhile.
type MoveGuard struct {
	// ParentGeneration is the generation of the new parent's key the client wrapped
	// the node's under. Nil asks for no check.
	ParentGeneration *int64
	// EditorID names who is moving a node that is not theirs: one grant of theirs
	// must cover both the old parent and the new one.
	EditorID string
}

func checkMoveInsideShare(ctx context.Context, q querier, userID, from, to string) error {
	before, err := lineageRoles(ctx, q, userID, from)
	if err != nil {
		return err
	}
	after, err := lineageRoles(ctx, q, userID, to)
	if err != nil {
		return err
	}
	for _, e := range before {
		if e.Role == RoleEditor && slices.ContainsFunc(after, func(a LineageEntry) bool { return a.NodeID == e.NodeID }) {
			return nil
		}
	}
	return ErrMoveOutOfShare
}

// granteesOver returns who holds a grant on a node or on anything above it.
func granteesOver(ctx context.Context, q querier, id string) (map[string]bool, error) {
	rows, err := q.QueryContext(ctx, `WITH RECURSIVE up (id, parent_id, depth) AS (
			SELECT id, parent_id, 0 FROM nodes WHERE id = ?
			UNION ALL
			SELECT n.id, n.parent_id, up.depth + 1 FROM nodes n JOIN up ON n.id = up.parent_id WHERE up.depth <= ?
		) SELECT DISTINCT g.grantee_id FROM up JOIN grants g ON g.node_id = up.id`, id, MaxTreeDepth+1)
	if err != nil {
		return nil, fmt.Errorf("store: read grantees: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]bool{}
	for rows.Next() {
		var user string
		if err := rows.Scan(&user); err != nil {
			return nil, fmt.Errorf("store: read grantees: %w", err)
		}
		out[user] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: read grantees: %w", err)
	}
	return out, nil
}

// MoveNode puts a node under another folder of the same owner, and in the same
// transaction replaces the key wrapped under the old parent and the name tag
// made under it. Whoever could reach the node only through where it was hears
// that they no longer can.
func (s *Store) MoveNode(ctx context.Context, id, parentID string, wrappedKey, nameTag []byte, guard MoveGuard, now time.Time) (Node, error) {
	return s.updateNode(ctx, id, OpMoved, now, func(tx *sql.Tx, n Node) (bool, error) {
		if n.ParentID == "" {
			return false, ErrRootImmutable
		}
		if err := checkNotTrashed(ctx, tx, id); err != nil {
			return false, err
		}
		parent, err := oneNode(ctx, tx, "id = ?", parentID)
		if err != nil {
			return false, err
		}
		if parent.OwnerID != n.OwnerID {
			return false, ErrMoveAcrossOwners
		}
		if guard.ParentGeneration != nil && *guard.ParentGeneration != parent.KeyGeneration {
			return false, ErrKeyGeneration
		}
		if guard.EditorID != "" {
			if err := checkMoveInsideShare(ctx, tx, guard.EditorID, n.ParentID, parentID); err != nil {
				return false, err
			}
		}
		if err := checkParent(ctx, tx, parent, id); err != nil {
			return false, err
		}
		if err := checkNameFree(ctx, tx, parentID, nameTag, id); err != nil {
			return false, err
		}
		before, err := granteesOver(ctx, tx, id)
		if err != nil {
			return false, err
		}
		_, err = tx.ExecContext(ctx, "UPDATE nodes SET parent_id = ?, wrapped_key = ?, name_tag = ? WHERE id = ?",
			parentID, nonNil(wrappedKey), nameTag, id)
		if err != nil {
			return false, fmt.Errorf("store: move node: %w", err)
		}
		after, err := granteesOver(ctx, tx, id)
		if err != nil {
			return false, err
		}
		for user := range before {
			if !after[user] {
				if err := recordFor(ctx, tx, user, id, OpRevoked, now); err != nil {
					return false, err
				}
			}
		}
		return true, nil
	})
}

// TrashNode sets the trashed time on the root of a subtree. Its descendants
// stay as they are and go wherever it goes. Trashing it twice changes nothing.
func (s *Store) TrashNode(ctx context.Context, id string, now time.Time) (Node, error) {
	return s.updateNode(ctx, id, OpTrashed, now, func(tx *sql.Tx, n Node) (bool, error) {
		if n.ParentID == "" {
			return false, ErrRootImmutable
		}
		if !n.TrashedAt.IsZero() {
			return false, nil
		}
		if _, err := tx.ExecContext(ctx, "UPDATE nodes SET trashed_at = ? WHERE id = ?", now.Unix(), id); err != nil {
			return false, fmt.Errorf("store: trash node: %w", err)
		}
		return true, recordBelow(ctx, tx, n.OwnerID, id, OpTrashed, now)
	})
}

// RestoreNode takes a node out of the trash, even one marked for removal whose
// time has not come. Its name is checked against the siblings it returns to.
func (s *Store) RestoreNode(ctx context.Context, id string, now time.Time) (Node, error) {
	return s.updateNode(ctx, id, OpRestored, now, func(tx *sql.Tx, n Node) (bool, error) {
		if n.TrashedAt.IsZero() {
			return false, ErrNotTrashed
		}
		chain, err := lineage(ctx, tx, n.ParentID)
		if err != nil {
			return false, err
		}
		for _, a := range chain {
			if a.trashed {
				return false, ErrParentTrashed
			}
		}
		if err := checkNameFree(ctx, tx, n.ParentID, n.NameTag, id); err != nil {
			return false, err
		}
		_, err = tx.ExecContext(ctx, "UPDATE nodes SET trashed_at = NULL, purged_at = NULL, remove_at = NULL WHERE id = ?", id)
		if err != nil {
			return false, fmt.Errorf("store: restore node: %w", err)
		}
		return true, recordBelow(ctx, tx, n.OwnerID, id, OpRestored, now)
	})
}

// PurgeNode marks a trashed subtree for removal at removeAt. The bytes stay and
// stay counted until then, and the time of an earlier mark stands: repeating the
// call neither brings it forward nor puts it off.
func (s *Store) PurgeNode(ctx context.Context, id string, now, removeAt time.Time) (Node, error) {
	return s.updateNode(ctx, id, OpPurged, now, func(tx *sql.Tx, n Node) (bool, error) {
		if n.TrashedAt.IsZero() {
			return false, ErrNotTrashed
		}
		if !n.PurgedAt.IsZero() {
			return false, nil
		}
		_, err := tx.ExecContext(ctx, "UPDATE nodes SET purged_at = ?, remove_at = ? WHERE id = ?", now.Unix(), removeAt.Unix(), id)
		if err != nil {
			return false, fmt.Errorf("store: purge node: %w", err)
		}
		return true, nil
	})
}

// EmptyTrash marks everything a user has in the trash for removal at removeAt,
// and returns how many nodes it marked.
func (s *Store) EmptyTrash(ctx context.Context, ownerID string, now, removeAt time.Time) (int, error) {
	var marked int
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		marked, err = markPurged(ctx, tx, "owner_id = ? AND trashed_at IS NOT NULL AND purged_at IS NULL", now, removeAt, ownerID)
		return err
	})
	return marked, err
}

// markPurged marks the nodes that match, and journals each.
func markPurged(ctx context.Context, tx *sql.Tx, where string, now, removeAt time.Time, args ...any) (int, error) {
	updated := now.Unix()
	rows, err := tx.QueryContext(ctx, "UPDATE nodes SET purged_at = ?, remove_at = ?, updated_at = ? WHERE "+where+" RETURNING id, owner_id", //nolint:gosec // where is a constant in this package
		append([]any{updated, removeAt.Unix(), updated}, args...)...)
	if err != nil {
		return 0, fmt.Errorf("store: mark nodes: %w", err)
	}
	type mark struct{ id, owner string }
	var marks []mark
	for rows.Next() {
		var m mark
		if err := rows.Scan(&m.id, &m.owner); err != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("store: mark nodes: %w", err)
		}
		marks = append(marks, m)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return 0, fmt.Errorf("store: mark nodes: %w", err)
	}
	for _, m := range marks {
		if err := recordChange(ctx, tx, m.owner, m.id, OpPurged, now); err != nil {
			return 0, err
		}
	}
	return len(marks), nil
}
