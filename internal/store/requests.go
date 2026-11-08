package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Errors of file requests. Callers match them with errors.Is.
var (
	// ErrRequestFileTooLarge means a file is larger than the request allows.
	ErrRequestFileTooLarge = errors.New("store: file is larger than the request allows")
	// ErrRequestFiles means the request has taken all the files it allows.
	ErrRequestFiles = errors.New("store: request has taken all its files")
	// ErrRequestBytes means the file does not fit in what the request has left.
	ErrRequestBytes = errors.New("store: request has no room for the file")
	// ErrIncomingPending means an item's upload has not completed.
	ErrIncomingPending = errors.New("store: incoming item is still on its way")
)

// MaxOpenRequestUploads is how many uploads one request may have in progress at
// once, whoever started them.
const MaxOpenRequestUploads = 20

// Incoming is a file sent through a request, waiting outside the tree for its
// owner's client to adopt it. Its ID is the one its node will have, and BlobID
// that of its upload until it completes, and of its blob after.
type Incoming struct {
	ID             string
	LinkID         string
	OwnerID        string
	BlobID         string
	VersionID      string
	Suite          string
	SealedKey      []byte
	SealedMetadata []byte
	// Size is the plaintext size, which counts against the request.
	Size        int64
	StoredSize  int64
	FrameCount  int64
	FrameSize   int64
	FrameHashes []byte
	CreatedAt   time.Time
	CompletedAt time.Time
}

const incomingColumns = `id, link_id, owner_id, blob_id, version_id, suite, sealed_key, sealed_metadata, size,
	stored_size, frame_count, frame_size, frame_hashes, created_at, completed_at`

func scanIncoming(row interface{ Scan(...any) error }) (Incoming, error) {
	var in Incoming
	var created int64
	var completed sql.NullInt64
	err := row.Scan(&in.ID, &in.LinkID, &in.OwnerID, &in.BlobID, &in.VersionID, &in.Suite, &in.SealedKey,
		&in.SealedMetadata, &in.Size, &in.StoredSize, &in.FrameCount, &in.FrameSize, &in.FrameHashes, &created, &completed)
	in.SealedKey = nonNil(in.SealedKey)
	in.CreatedAt, in.CompletedAt = time.Unix(created, 0).UTC(), fromNull(completed)
	return in, err
}

func oneIncoming(ctx context.Context, q querier, where, arg string) (Incoming, error) {
	in, err := scanIncoming(q.QueryRowContext(ctx, "SELECT "+incomingColumns+" FROM incoming WHERE "+where, arg))
	if errors.Is(err, sql.ErrNoRows) {
		return Incoming{}, ErrNotFound
	}
	if err != nil {
		return Incoming{}, fmt.Errorf("store: read incoming: %w", err)
	}
	return in, nil
}

// IncomingByID returns an incoming item, complete or not, or ErrNotFound.
func (s *Store) IncomingByID(ctx context.Context, id string) (Incoming, error) {
	return oneIncoming(ctx, s.read, "id = ?", id)
}

// CreateRequestUpload starts an upload through a request: the upload, which
// reserves room in the owner's quota as any other does, and the item it will
// become. The request's limits and the ids are decided in the same transaction,
// so uploads that start together cannot pass a limit together. The caller fills
// in the item but for its owner and what is sealed, which comes with the commit.
func (s *Store) CreateRequestUpload(ctx context.Context, linkID string, in Incoming) (Upload, error) {
	var out Upload
	err := s.tx(ctx, func(tx *sql.Tx) error {
		l, err := oneLink(ctx, tx, linkID)
		if err != nil {
			return err
		}
		if l.Kind != LinkKindRequest {
			return ErrNotFound
		}
		if err := checkNotTrashed(ctx, tx, l.NodeID); err != nil {
			return err
		}
		if l.MaxFileSize > 0 && in.Size > l.MaxFileSize {
			return ErrRequestFileTooLarge
		}
		if l.FileLimit > 0 && l.FilesReceived >= l.FileLimit {
			return ErrRequestFiles
		}
		if l.BytesLimit > 0 && l.BytesReceived+in.Size > l.BytesLimit {
			return ErrRequestBytes
		}
		var open int
		err = tx.QueryRowContext(ctx, "SELECT count(*) FROM uploads WHERE link_id = ?", l.ID).Scan(&open)
		if err != nil {
			return fmt.Errorf("store: count uploads: %w", err)
		}
		if open >= MaxOpenRequestUploads {
			return ErrTooManyUploads
		}
		var exists int
		err = tx.QueryRowContext(ctx, "SELECT 1 FROM nodes WHERE id = ? UNION ALL SELECT 1 FROM incoming WHERE id = ?",
			in.ID, in.ID).Scan(&exists)
		if err == nil {
			return ErrIDTaken
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: check node id: %w", err)
		}
		if err := checkVersionIDFree(ctx, tx, in.VersionID); err != nil {
			return err
		}
		if err := checkRoom(ctx, tx, l.OwnerID, in.StoredSize); err != nil {
			return err
		}
		created := in.CreatedAt.Unix()
		_, err = tx.ExecContext(ctx, `INSERT INTO uploads (id, user_id, owner_id, node_id, version_id, suite,
			frame_count, frame_size, stored_size, key_generation, link_id, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
			in.BlobID, l.OwnerID, l.OwnerID, l.NodeID, in.VersionID, in.Suite,
			in.FrameCount, in.FrameSize, in.StoredSize, l.ID, created, created)
		if err != nil {
			return fmt.Errorf("store: insert upload: %w", err)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO incoming (id, link_id, owner_id, blob_id, version_id, suite, sealed_key,
			sealed_metadata, size, stored_size, frame_count, frame_size, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			in.ID, l.ID, l.OwnerID, in.BlobID, in.VersionID, in.Suite, nonNil(in.SealedKey), nonNil(in.SealedMetadata),
			in.Size, in.StoredSize, in.FrameCount, in.FrameSize, created)
		if err != nil {
			return fmt.Errorf("store: insert incoming: %w", err)
		}
		_, err = tx.ExecContext(ctx, `UPDATE links SET files_received = files_received + 1,
			bytes_received = bytes_received + ? WHERE id = ?`, in.Size, l.ID)
		if err != nil {
			return fmt.Errorf("store: count request: %w", err)
		}
		out, err = oneUpload(ctx, tx, in.BlobID)
		return err
	})
	return out, err
}

// CommitRequestUpload turns a complete upload through a request into an incoming
// item that waits for its owner, with the node key and metadata its sender sealed.
// place moves the file into position, as in CommitUpload. The blob belongs to no
// node until the item is adopted, and counts against the owner's quota from now on.
func (s *Store) CommitRequestUpload(ctx context.Context, uploadID string, sealedKey, sealedMetadata []byte, now time.Time, place func(Upload) error) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		u, err := oneUpload(ctx, tx, uploadID)
		if err != nil {
			return err
		}
		if u.LinkID == "" {
			return ErrNotFound
		}
		hashes, err := frameHashes(ctx, tx, u)
		if err != nil {
			return err
		}
		if err := place(u); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO blobs (id, owner_id, node_id, kind, suite, size, ref_count, created_at)
			VALUES (?, ?, NULL, ?, ?, ?, 0, ?)`, u.ID, u.OwnerID, BlobContent, u.Suite, u.StoredSize, now.Unix())
		if err != nil {
			return fmt.Errorf("store: insert blob: %w", err)
		}
		res, err := tx.ExecContext(ctx, `UPDATE incoming SET completed_at = ?, frame_hashes = ?, sealed_key = ?, sealed_metadata = ?
			WHERE blob_id = ? AND completed_at IS NULL`, now.Unix(), hashes, nonNil(sealedKey), sealedMetadata, u.ID)
		if err != nil {
			return fmt.Errorf("store: complete incoming: %w", err)
		}
		if err := requireRow(res, ErrNotFound); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM uploads WHERE id = ?", u.ID); err != nil {
			return fmt.Errorf("store: delete upload: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM file_removals WHERE kind = ? AND id = ?", RemoveUpload, u.ID); err != nil {
			return fmt.Errorf("store: clear removal: %w", err)
		}
		return nil
	})
}

// ListIncoming returns a page of the items that have arrived for a user and wait
// to be adopted, by id.
func (s *Store) ListIncoming(ctx context.Context, ownerID, after string, limit int) ([]Incoming, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT "+incomingColumns+
		" FROM incoming WHERE owner_id = ? AND completed_at IS NOT NULL AND id > ? ORDER BY id LIMIT ?", ownerID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list incoming: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Incoming
	for rows.Next() {
		in, err := scanIncoming(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list incoming: %w", err)
		}
		out = append(out, in)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list incoming: %w", err)
	}
	return out, nil
}

// Adoption is what the owner's client makes of an incoming item to put it in
// the tree: the node's key wrapped under the folder's, its name tag and its
// metadata, sealed again, and the manifest signed by the owner.
type Adoption struct {
	ParentGeneration *int64
	WrappedKey       []byte
	NameTag          []byte
	SealedMetadata   []byte
	Signature        []byte
	Manifest         []byte
}

// AdoptIncoming makes a complete item a file in its request's folder, with the
// item's blob as its first version. The frames stay as they were sent: they are
// sealed under the node's key, which only moves. The item goes, and nothing about
// its blob is charged again.
func (s *Store) AdoptIncoming(ctx context.Context, id string, a Adoption, now time.Time) (Node, Version, error) {
	var node Node
	var version Version
	err := s.tx(ctx, func(tx *sql.Tx) error {
		in, err := oneIncoming(ctx, tx, "id = ?", id)
		if err != nil {
			return err
		}
		if in.CompletedAt.IsZero() {
			return ErrIncomingPending
		}
		l, err := oneLink(ctx, tx, in.LinkID)
		if err != nil {
			return err
		}
		folder, err := oneNode(ctx, tx, "id = ?", l.NodeID)
		if err != nil {
			return err
		}
		if a.ParentGeneration != nil && *a.ParentGeneration != folder.KeyGeneration {
			return ErrKeyGeneration
		}
		if err := checkParent(ctx, tx, folder, ""); err != nil {
			return err
		}
		if err := checkNameFree(ctx, tx, folder.ID, a.NameTag, ""); err != nil {
			return err
		}
		if err := checkRoom(ctx, tx, in.OwnerID, int64(len(a.SealedMetadata))); err != nil {
			return err
		}
		n := Node{
			ID: in.ID, OwnerID: in.OwnerID, ParentID: folder.ID, Kind: KindFile, Suite: in.Suite,
			SealedMetadata: a.SealedMetadata, WrappedKey: a.WrappedKey, NameTag: a.NameTag, CreatedAt: now, UpdatedAt: now,
		}
		if err := insertNode(ctx, tx, n); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE blobs SET node_id = ? WHERE id = ?", in.ID, in.BlobID); err != nil {
			return fmt.Errorf("store: adopt blob: %w", err)
		}
		v := Version{
			ID: in.VersionID, NodeID: in.ID, BlobID: in.BlobID, Suite: in.Suite, AuthorID: in.OwnerID,
			ContentVersionID: in.VersionID, ContentAuthorID: in.OwnerID, StoredSize: in.StoredSize,
			FrameCount: in.FrameCount, FrameSize: in.FrameSize, KeyGeneration: 1, FrameHashes: in.FrameHashes,
			Signature: a.Signature, Manifest: a.Manifest, CreatedAt: now,
		}
		if err := insertVersion(ctx, tx, in.OwnerID, v); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM incoming WHERE id = ?", in.ID); err != nil {
			return fmt.Errorf("store: delete incoming: %w", err)
		}
		if node, err = oneNode(ctx, tx, "id = ?", in.ID); err != nil {
			return err
		}
		version, err = oneVersion(ctx, tx, in.ID, in.VersionID)
		return err
	})
	return node, version, err
}

// DeleteIncoming drops an item, its upload or its blob with it, or fails with
// ErrNotFound. What it took of its request stays taken once it had arrived.
func (s *Store) DeleteIncoming(ctx context.Context, id string) error {
	res, err := s.write.ExecContext(ctx, "DELETE FROM incoming WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("store: delete incoming: %w", err)
	}
	return requireRow(res, ErrNotFound)
}

// RemoveEndedIncoming drops up to limit items whose request ended, by expiry or
// revocation, before cutoff, and returns how many.
func (s *Store) RemoveEndedIncoming(ctx context.Context, cutoff time.Time, limit int) (int64, error) {
	res, err := s.write.ExecContext(ctx, `DELETE FROM incoming WHERE id IN (
		SELECT i.id FROM incoming i JOIN links l ON l.id = i.link_id
		WHERE l.revoked_at < ? OR l.expires_at < ? LIMIT ?)`, cutoff.Unix(), cutoff.Unix(), limit)
	if err != nil {
		return 0, fmt.Errorf("store: remove incoming: %w", err)
	}
	return res.RowsAffected()
}

// IncomingByBlob returns the item an upload became, or is becoming, or ErrNotFound.
func (s *Store) IncomingByBlob(ctx context.Context, blobID string) (Incoming, error) {
	return oneIncoming(ctx, s.read, "blob_id = ?", blobID)
}

// RemoveIdleRequestUploads deletes up to limit uploads through requests that have
// received nothing since before cutoff, which gives their places on the request
// back, and returns how many. Anyone with a request's address can start one, so
// they are not left to hold its places as long as an account's uploads may.
func (s *Store) RemoveIdleRequestUploads(ctx context.Context, cutoff time.Time, limit int) (int64, error) {
	res, err := s.write.ExecContext(ctx, `DELETE FROM uploads WHERE id IN (
		SELECT id FROM uploads WHERE link_id IS NOT NULL AND updated_at < ? LIMIT ?)`, cutoff.Unix(), limit)
	if err != nil {
		return 0, fmt.Errorf("store: remove request uploads: %w", err)
	}
	return res.RowsAffected()
}
