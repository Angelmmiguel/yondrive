package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Kinds of link, and the one role a view link gives.
const (
	LinkKindView    = "view"
	LinkKindRequest = "request"
	LinkRoleView    = "view"
)

// ErrLinkLimit means a link has counted all the downloads it allows.
var ErrLinkLimit = errors.New("store: link has reached its download limit")

// Link is a public link to a node and everything under it, or a request for
// files into a folder. The keys are opaque. KDF is nil on a link with no
// password. A zero time and a zero limit mean none.
type Link struct {
	ID      string
	NodeID  string
	OwnerID string
	Kind    string
	// Role is what a view link gives, and empty on a request.
	Role          string
	KeyGeneration int64
	SealedKey     []byte
	// OwnerSealedKey holds a view link's key, or a request's private key, for
	// its owner.
	OwnerSealedKey []byte
	// PublicKey is a request's X25519 public key, and nil on a view link.
	PublicKey          []byte
	KDF                []byte
	PasswordWrappedKey []byte
	AuthHash           []byte
	ExpiresAt          time.Time
	DownloadLimit      int64
	DownloadCount      int64
	// The limits of a request, in plaintext bytes, and what has arrived or is on
	// its way.
	MaxFileSize   int64
	FileLimit     int64
	BytesLimit    int64
	FilesReceived int64
	BytesReceived int64
	// UploadsInProgress is how many uploads through a request have not completed.
	UploadsInProgress int64
	RevokedAt         time.Time
	CreatedAt         time.Time
}

const linkColumns = `id, node_id, owner_id, kind, coalesce(role, ''), key_generation, sealed_key, owner_sealed_key,
	public_key, kdf, password_wrapped_key, auth_hash, expires_at, coalesce(download_limit, 0), download_count,
	coalesce(max_file_size, 0), coalesce(file_limit, 0), coalesce(bytes_limit, 0), files_received, bytes_received,
	(SELECT count(*) FROM uploads WHERE uploads.link_id = links.id),
	revoked_at, created_at`

func scanLink(row interface{ Scan(...any) error }) (Link, error) {
	var l Link
	var expires, revoked sql.NullInt64
	var created int64
	err := row.Scan(&l.ID, &l.NodeID, &l.OwnerID, &l.Kind, &l.Role, &l.KeyGeneration, &l.SealedKey, &l.OwnerSealedKey,
		&l.PublicKey, &l.KDF, &l.PasswordWrappedKey, &l.AuthHash, &expires, &l.DownloadLimit, &l.DownloadCount,
		&l.MaxFileSize, &l.FileLimit, &l.BytesLimit, &l.FilesReceived, &l.BytesReceived, &l.UploadsInProgress, &revoked, &created)
	l.SealedKey, l.OwnerSealedKey = nonNil(l.SealedKey), nonNil(l.OwnerSealedKey)
	if l.Kind == LinkKindRequest {
		l.PublicKey = nonNil(l.PublicKey)
	}
	l.ExpiresAt, l.RevokedAt = fromNull(expires), fromNull(revoked)
	l.CreatedAt = time.Unix(created, 0).UTC()
	return l, err
}

func oneLink(ctx context.Context, q querier, id string) (Link, error) {
	l, err := scanLink(q.QueryRowContext(ctx, "SELECT "+linkColumns+" FROM links WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Link{}, ErrNotFound
	}
	if err != nil {
		return Link{}, fmt.Errorf("store: read link: %w", err)
	}
	return l, nil
}

// LinkByID returns a link, or ErrNotFound.
func (s *Store) LinkByID(ctx context.Context, id string) (Link, error) {
	return oneLink(ctx, s.read, id)
}

// CreateLink adds a link to a node, whose key it seals at the generation it
// names. As with a grant, a root cannot be shared and neither can the trash.
func (s *Store) CreateLink(ctx context.Context, l Link) (Link, error) {
	var out Link
	err := s.tx(ctx, func(tx *sql.Tx) error {
		n, err := oneNode(ctx, tx, "id = ?", l.NodeID)
		if err != nil {
			return err
		}
		if n.ParentID == "" {
			return ErrRootImmutable
		}
		if err := checkNotTrashed(ctx, tx, n.ID); err != nil {
			return err
		}
		if n.KeyGeneration != l.KeyGeneration {
			return ErrKeyGeneration
		}
		if l.Kind == LinkKindRequest && n.Kind != KindFolder {
			return ErrNotFolder
		}
		var exists int
		err = tx.QueryRowContext(ctx, "SELECT 1 FROM links WHERE id = ?", l.ID).Scan(&exists)
		if err == nil {
			return ErrIDTaken
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: check link id: %w", err)
		}
		var expires sql.NullInt64
		if !l.ExpiresAt.IsZero() {
			expires = sql.NullInt64{Int64: l.ExpiresAt.Unix(), Valid: true}
		}
		var role, public any
		if l.Kind == LinkKindRequest {
			public = nonNil(l.PublicKey)
		} else {
			role = l.Role
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO links (id, node_id, owner_id, kind, role, key_generation, sealed_key,
			owner_sealed_key, public_key, kdf, password_wrapped_key, auth_hash, expires_at, download_limit,
			max_file_size, file_limit, bytes_limit, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			l.ID, l.NodeID, l.OwnerID, l.Kind, role, l.KeyGeneration, nonNil(l.SealedKey), nonNil(l.OwnerSealedKey),
			public, l.KDF, l.PasswordWrappedKey, l.AuthHash, expires, positive(l.DownloadLimit),
			positive(l.MaxFileSize), positive(l.FileLimit), positive(l.BytesLimit), l.CreatedAt.Unix())
		if err != nil {
			return fmt.Errorf("store: insert link: %w", err)
		}
		out, err = oneLink(ctx, tx, l.ID)
		return err
	})
	return out, err
}

// positive is a limit as it is stored: NULL for none.
func positive(n int64) sql.NullInt64 {
	return sql.NullInt64{Int64: n, Valid: n > 0}
}

// ListLinksByOwner returns a page of the links a user has made, by id.
func (s *Store) ListLinksByOwner(ctx context.Context, ownerID, after string, limit int) ([]Link, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT "+linkColumns+" FROM links WHERE owner_id = ? AND id > ? ORDER BY id LIMIT ?", ownerID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list links: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Link
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list links: %w", err)
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list links: %w", err)
	}
	return out, nil
}

// RevokeLink ends a link and keeps its row, or fails with ErrNotFound. An earlier
// revocation stands.
func (s *Store) RevokeLink(ctx context.Context, id string, now time.Time) (Link, error) {
	var out Link
	err := s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, "UPDATE links SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?", now.Unix(), id)
		if err != nil {
			return fmt.Errorf("store: revoke link: %w", err)
		}
		if err := requireRow(res, ErrNotFound); err != nil {
			return err
		}
		out, err = oneLink(ctx, tx, id)
		return err
	})
	return out, err
}

// DeleteLink forgets a link, or fails with ErrNotFound.
func (s *Store) DeleteLink(ctx context.Context, id string) error {
	res, err := s.write.ExecContext(ctx, "DELETE FROM links WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("store: delete link: %w", err)
	}
	return requireRow(res, ErrNotFound)
}

// ClaimLinkDownload counts a stored file against a link's limit, once for each
// viewing session, or fails with ErrLinkLimit. Writes are serialised, so
// concurrent claims cannot pass the limit together.
func (s *Store) ClaimLinkDownload(ctx context.Context, linkID, sessionID, blobID string, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO link_downloads (link_id, session_id, blob_id, created_at)
			VALUES (?, ?, ?, ?)`, linkID, sessionID, blobID, now.Unix())
		if err != nil {
			return fmt.Errorf("store: claim download: %w", err)
		}
		if n, err := res.RowsAffected(); err != nil {
			return fmt.Errorf("store: claim download: %w", err)
		} else if n == 0 {
			return nil
		}
		res, err = tx.ExecContext(ctx, `UPDATE links SET download_count = download_count + 1
			WHERE id = ? AND (download_limit IS NULL OR download_count < download_limit)`, linkID)
		if err != nil {
			return fmt.Errorf("store: count download: %w", err)
		}
		return requireRow(res, ErrLinkLimit)
	})
}

// RemoveStaleLinkDownloads forgets what sessions begun before cutoff claimed. No
// such session can still read, so it could only ever count again.
func (s *Store) RemoveStaleLinkDownloads(ctx context.Context, cutoff time.Time) error {
	if _, err := s.write.ExecContext(ctx, "DELETE FROM link_downloads WHERE created_at < ?", cutoff.Unix()); err != nil {
		return fmt.Errorf("store: remove link downloads: %w", err)
	}
	return nil
}

// NodeVisibleUnder reports whether a node is root or under it, with nothing from
// the node up to the top of the tree in the trash. A link reaches no further.
func (s *Store) NodeVisibleUnder(ctx context.Context, root, nodeID string) (bool, error) {
	chain, err := lineage(ctx, s.read, nodeID)
	if err != nil {
		return false, err
	}
	inside := false
	for _, a := range chain {
		if a.trashed {
			return false, nil
		}
		inside = inside || a.id == root
	}
	return inside, nil
}
