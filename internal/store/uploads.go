package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Errors of uploads and blobs. Callers match them with errors.Is.
var (
	// ErrQuotaExceeded means the owner's quota has no room.
	ErrQuotaExceeded = errors.New("store: quota exceeded")
	// ErrUploadIncomplete means frames are missing.
	ErrUploadIncomplete = errors.New("store: upload is incomplete")
	// ErrFrameConflict means the frame arrived before with another digest.
	ErrFrameConflict = errors.New("store: frame arrived with another digest")
	// ErrBlobKept means the blob is content, which goes with its versions.
	ErrBlobKept = errors.New("store: blob belongs to a version")
	// ErrTooManyUploads means the user has MaxOpenUploads uploads in progress.
	ErrTooManyUploads = errors.New("store: too many uploads in progress")
)

// MaxOpenUploads is how many uploads one user may have in progress at once. Each
// holds an open file and a row that every frame writes to, and an account with
// no quota could otherwise reserve the disk with uploads it never finishes.
const MaxOpenUploads = 100

// Kinds of blob.
const (
	BlobContent = "content"
	BlobThumb   = "thumb"
	BlobIndex   = "index"
)

// Upload is a version on its way in. Its id becomes the id of the blob.
type Upload struct {
	ID         string
	UserID     string
	OwnerID    string
	NodeID     string
	VersionID  string
	Suite      string
	FrameCount int64
	FrameSize  int64
	StoredSize int64
	// KeyGeneration is the generation of the node's key the frames are sealed under.
	// On the way in, zero means whichever is current.
	KeyGeneration int64
	// LinkID names the request an anonymous upload came through; NodeID is then
	// the request's folder, and UserID its owner.
	LinkID    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

const uploadColumns = `id, user_id, owner_id, node_id, version_id, suite, frame_count, frame_size, stored_size, key_generation,
	coalesce(link_id, ''), created_at, updated_at`

func oneUpload(ctx context.Context, q querier, id string) (Upload, error) {
	var u Upload
	var created, updated int64
	err := q.QueryRowContext(ctx, "SELECT "+uploadColumns+" FROM uploads WHERE id = ?", id).Scan(
		&u.ID, &u.UserID, &u.OwnerID, &u.NodeID, &u.VersionID, &u.Suite, &u.FrameCount, &u.FrameSize, &u.StoredSize, &u.KeyGeneration,
		&u.LinkID, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Upload{}, ErrNotFound
	}
	if err != nil {
		return Upload{}, fmt.Errorf("store: read upload: %w", err)
	}
	u.CreatedAt, u.UpdatedAt = time.Unix(created, 0).UTC(), time.Unix(updated, 0).UTC()
	return u, nil
}

// UploadByID returns an upload, or ErrNotFound.
func (s *Store) UploadByID(ctx context.Context, id string) (Upload, error) {
	return oneUpload(ctx, s.read, id)
}

// Usage is what a user's quota holds. Quota zero means no limit.
type Usage struct {
	QuotaBytes    int64
	UsedBytes     int64
	ReservedBytes int64
}

// UsageOf returns a user's storage figures.
func (s *Store) UsageOf(ctx context.Context, userID string) (Usage, error) {
	return usageOf(ctx, s.read, userID)
}

func usageOf(ctx context.Context, q querier, userID string) (Usage, error) {
	var u Usage
	err := q.QueryRowContext(ctx, "SELECT quota_bytes, used_bytes, reserved_bytes FROM users WHERE id = ?", userID).
		Scan(&u.QuotaBytes, &u.UsedBytes, &u.ReservedBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return Usage{}, ErrNotFound
	}
	if err != nil {
		return Usage{}, fmt.Errorf("store: read usage: %w", err)
	}
	return u, nil
}

// checkRoom refuses size more bytes.
func checkRoom(ctx context.Context, q querier, ownerID string, size int64) error {
	u, err := usageOf(ctx, q, ownerID)
	if err != nil {
		return err
	}
	if u.QuotaBytes > 0 && u.UsedBytes+u.ReservedBytes+size > u.QuotaBytes {
		return ErrQuotaExceeded
	}
	return nil
}

// CreateUpload reserves room for a version of a file. The id, the version id and
// the room are all decided in one transaction. The caller fills in everything
// but OwnerID, which comes from the node.
func (s *Store) CreateUpload(ctx context.Context, u Upload) (Upload, error) {
	var out Upload
	err := s.tx(ctx, func(tx *sql.Tx) error {
		n, err := oneNode(ctx, tx, "id = ?", u.NodeID)
		if err != nil {
			return err
		}
		if n.Kind != KindFile {
			return ErrNotFile
		}
		if err := checkNotTrashed(ctx, tx, u.NodeID); err != nil {
			return err
		}
		if u.KeyGeneration != 0 && u.KeyGeneration != n.KeyGeneration {
			return ErrKeyGeneration
		}
		if err := checkVersionIDFree(ctx, tx, u.VersionID); err != nil {
			return err
		}
		var open int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM uploads WHERE user_id = ? AND link_id IS NULL", u.UserID).Scan(&open); err != nil {
			return fmt.Errorf("store: count uploads: %w", err)
		}
		if open >= MaxOpenUploads {
			return ErrTooManyUploads
		}
		if err := checkRoom(ctx, tx, n.OwnerID, u.StoredSize); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO uploads (id, user_id, owner_id, node_id, version_id, suite,
			frame_count, frame_size, stored_size, key_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			u.ID, u.UserID, n.OwnerID, u.NodeID, u.VersionID, u.Suite,
			u.FrameCount, u.FrameSize, u.StoredSize, n.KeyGeneration, u.CreatedAt.Unix(), u.CreatedAt.Unix())
		if err != nil {
			return fmt.Errorf("store: insert upload: %w", err)
		}
		out, err = oneUpload(ctx, tx, u.ID)
		return err
	})
	return out, err
}

// FrameHash returns the digest of a frame that has arrived, or nil.
func (s *Store) FrameHash(ctx context.Context, uploadID string, index int64) ([]byte, error) {
	var sum []byte
	err := s.read.QueryRowContext(ctx, "SELECT sha256 FROM upload_frames WHERE upload_id = ? AND idx = ?", uploadID, index).Scan(&sum)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("store: read frame: %w", err)
	}
	return sum, nil
}

// RecordFrame notes that a frame is on disk. A frame arrives once: the same
// digest again is a retry, and any other is ErrFrameConflict.
func (s *Store) RecordFrame(ctx context.Context, uploadID string, index int64, sum []byte, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, "UPDATE uploads SET updated_at = ? WHERE id = ?", now.Unix(), uploadID)
		if err != nil {
			return fmt.Errorf("store: touch upload: %w", err)
		}
		if err := requireRow(res, ErrNotFound); err != nil {
			return err
		}
		var existing []byte
		err = tx.QueryRowContext(ctx, "SELECT sha256 FROM upload_frames WHERE upload_id = ? AND idx = ?", uploadID, index).Scan(&existing)
		if err == nil {
			if !bytes.Equal(existing, sum) {
				return ErrFrameConflict
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: read frame: %w", err)
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO upload_frames (upload_id, idx, sha256) VALUES (?, ?, ?)", uploadID, index, sum)
		if err != nil {
			return fmt.Errorf("store: record frame: %w", err)
		}
		return nil
	})
}

// UploadedFrames returns the indexes of the frames that have arrived, in order.
func (s *Store) UploadedFrames(ctx context.Context, uploadID string) ([]int64, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT idx FROM upload_frames WHERE upload_id = ? ORDER BY idx", uploadID)
	if err != nil {
		return nil, fmt.Errorf("store: list frames: %w", err)
	}
	defer func() { _ = rows.Close() }()
	frames := []int64{}
	for rows.Next() {
		var i int64
		if err := rows.Scan(&i); err != nil {
			return nil, fmt.Errorf("store: list frames: %w", err)
		}
		frames = append(frames, i)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list frames: %w", err)
	}
	return frames, nil
}

// CommitRequest is what a client adds when it commits an upload: only then can
// it have signed the content hash.
type CommitRequest struct {
	Signature []byte
	Manifest  []byte
	// Expected is the version the save started from: nil asks for no check, and
	// empty means the node must have no version yet.
	Expected *string
}

// CommitUpload turns a complete upload into the node's current version. place
// moves the file into its final position; it runs once everything else has been
// checked, and inside the transaction, so that a refused commit leaves the
// upload as it was and no two commits can run together. If the transaction then
// fails the file stays placed, and both a retry and the check at startup deal
// with that. The bytes change from reserved to used in the same commit.
func (s *Store) CommitUpload(ctx context.Context, uploadID string, req CommitRequest, now time.Time, place func(Upload) error) (Version, error) {
	var out Version
	err := s.tx(ctx, func(tx *sql.Tx) error {
		u, err := oneUpload(ctx, tx, uploadID)
		if err != nil {
			return err
		}
		// One through a request becomes an incoming item, never a version here.
		if u.LinkID != "" {
			return ErrNotFound
		}
		n, err := oneNode(ctx, tx, "id = ?", u.NodeID)
		if err != nil {
			return err
		}
		if err := checkNotTrashed(ctx, tx, u.NodeID); err != nil {
			return err
		}
		if err := checkExpected(n, req.Expected); err != nil {
			return err
		}
		// A rotation since the upload began would leave the old key on new content.
		if u.KeyGeneration != n.KeyGeneration {
			return ErrKeyGeneration
		}
		hashes, err := frameHashes(ctx, tx, u)
		if err != nil {
			return err
		}
		if err := place(u); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO blobs (id, owner_id, node_id, kind, suite, size, ref_count, created_at)
			VALUES (?, ?, ?, ?, ?, ?, 0, ?)`, u.ID, u.OwnerID, u.NodeID, BlobContent, u.Suite, u.StoredSize, now.Unix())
		if err != nil {
			return fmt.Errorf("store: insert blob: %w", err)
		}
		v := Version{
			ID: u.VersionID, NodeID: u.NodeID, BlobID: u.ID, Suite: u.Suite, AuthorID: u.UserID,
			ContentVersionID: u.VersionID, ContentAuthorID: u.UserID, StoredSize: u.StoredSize,
			FrameCount: u.FrameCount, FrameSize: u.FrameSize, KeyGeneration: u.KeyGeneration, FrameHashes: hashes,
			Signature: req.Signature, Manifest: req.Manifest, CreatedAt: now,
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM uploads WHERE id = ?", u.ID); err != nil {
			return fmt.Errorf("store: delete upload: %w", err)
		}
		// The file has moved, so its removal has nothing to do.
		if _, err := tx.ExecContext(ctx, "DELETE FROM file_removals WHERE kind = ? AND id = ?", RemoveUpload, u.ID); err != nil {
			return fmt.Errorf("store: clear removal: %w", err)
		}
		if err := insertVersion(ctx, tx, u.OwnerID, v); err != nil {
			return err
		}
		out, err = oneVersion(ctx, tx, u.NodeID, u.VersionID)
		return err
	})
	return out, err
}

// frameHashes concatenates the digests of a complete upload, or fails with
// ErrUploadIncomplete.
func frameHashes(ctx context.Context, q querier, u Upload) ([]byte, error) {
	rows, err := q.QueryContext(ctx, "SELECT sha256 FROM upload_frames WHERE upload_id = ? ORDER BY idx", u.ID)
	if err != nil {
		return nil, fmt.Errorf("store: read frames: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var all []byte
	var count int64
	for rows.Next() {
		var sum []byte
		if err := rows.Scan(&sum); err != nil {
			return nil, fmt.Errorf("store: read frames: %w", err)
		}
		all = append(all, sum...)
		count++
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: read frames: %w", err)
	}
	if count != u.FrameCount {
		return nil, ErrUploadIncomplete
	}
	return all, nil
}

// UploadSummary is an upload in a list, with how many frames have arrived.
type UploadSummary struct {
	Upload
	FramesReceived int64
}

// ListUploads returns a page of the uploads a user started and has not finished,
// in id order, after the id given.
func (s *Store) ListUploads(ctx context.Context, userID, after string, limit int) ([]UploadSummary, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT "+uploadColumns+`, (SELECT count(*) FROM upload_frames WHERE upload_id = uploads.id)
		FROM uploads WHERE user_id = ? AND link_id IS NULL AND id > ? ORDER BY id LIMIT ?`, userID, after, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list uploads: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []UploadSummary
	for rows.Next() {
		var u UploadSummary
		var created, updated int64
		err := rows.Scan(&u.ID, &u.UserID, &u.OwnerID, &u.NodeID, &u.VersionID, &u.Suite, &u.FrameCount, &u.FrameSize,
			&u.StoredSize, &u.KeyGeneration, &u.LinkID, &created, &updated, &u.FramesReceived)
		if err != nil {
			return nil, fmt.Errorf("store: list uploads: %w", err)
		}
		u.CreatedAt, u.UpdatedAt = time.Unix(created, 0).UTC(), time.Unix(updated, 0).UTC()
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list uploads: %w", err)
	}
	return out, nil
}

// DeleteUpload forgets an upload and releases its reservation, or fails with
// ErrNotFound. The file is queued for removal.
func (s *Store) DeleteUpload(ctx context.Context, id string) error {
	res, err := s.write.ExecContext(ctx, "DELETE FROM uploads WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("store: delete upload: %w", err)
	}
	return requireRow(res, ErrNotFound)
}

// Blob is a stored file. NodeID is empty for one tied only to its owner.
type Blob struct {
	ID        string
	OwnerID   string
	NodeID    string
	Kind      string
	Suite     string
	Size      int64
	CreatedAt time.Time
}

const blobColumns = `id, owner_id, coalesce(node_id, ''), kind, suite, size, created_at`

func scanBlob(row interface{ Scan(...any) error }) (Blob, error) {
	var b Blob
	var created int64
	err := row.Scan(&b.ID, &b.OwnerID, &b.NodeID, &b.Kind, &b.Suite, &b.Size, &created)
	b.CreatedAt = time.Unix(created, 0).UTC()
	return b, err
}

func oneBlob(ctx context.Context, q querier, id string) (Blob, error) {
	b, err := scanBlob(q.QueryRowContext(ctx, "SELECT "+blobColumns+" FROM blobs WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return Blob{}, ErrNotFound
	}
	if err != nil {
		return Blob{}, fmt.Errorf("store: read blob: %w", err)
	}
	return b, nil
}

// BlobByID returns a blob, or ErrNotFound.
func (s *Store) BlobByID(ctx context.Context, id string) (Blob, error) {
	return oneBlob(ctx, s.read, id)
}

// PutSmallBlob stores a thumbnail or an index segment, whose id the client
// chose. A node has one thumbnail, so a new one replaces it and its bytes count
// no longer. place puts the file in position, as in CommitUpload. The id must be
// free of files still waiting for removal as well: their unlink would take this
// file with it.
func (s *Store) PutSmallBlob(ctx context.Context, b Blob, place func() error) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var exists int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM blobs WHERE id = ?
			UNION ALL SELECT 1 FROM uploads WHERE id = ?
			UNION ALL SELECT 1 FROM file_removals WHERE id = ?`, b.ID, b.ID, b.ID).Scan(&exists)
		if err == nil {
			return ErrIDTaken
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("store: check blob id: %w", err)
		}
		if b.Kind == BlobThumb {
			// A refused quota rolls this back. The trigger takes the old bytes off
			// the figure that checkRoom reads.
			if _, err := tx.ExecContext(ctx, "DELETE FROM blobs WHERE node_id = ? AND kind = ?", b.NodeID, BlobThumb); err != nil {
				return fmt.Errorf("store: replace thumbnail: %w", err)
			}
		}
		if err := checkRoom(ctx, tx, b.OwnerID, b.Size); err != nil {
			return err
		}
		if err := place(); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO blobs (id, owner_id, node_id, kind, suite, size, ref_count, created_at)
			VALUES (?, ?, nullif(?, ''), ?, ?, ?, 1, ?)`, b.ID, b.OwnerID, b.NodeID, b.Kind, b.Suite, b.Size, b.CreatedAt.Unix())
		if err != nil {
			return fmt.Errorf("store: insert blob: %w", err)
		}
		if b.Kind == BlobThumb {
			return recordChange(ctx, tx, b.OwnerID, b.NodeID, OpThumbnail, b.CreatedAt)
		}
		return nil
	})
}

// DeleteSmallBlob removes a thumbnail or an index segment. They can be made
// again by a client, so they have no grace period. Content goes with its
// versions, and fails with ErrBlobKept.
func (s *Store) DeleteSmallBlob(ctx context.Context, id string, now time.Time) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		b, err := oneBlob(ctx, tx, id)
		if err != nil {
			return err
		}
		if b.Kind == BlobContent {
			return ErrBlobKept
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM blobs WHERE id = ?", id); err != nil {
			return fmt.Errorf("store: delete blob: %w", err)
		}
		if b.Kind == BlobThumb {
			return recordChange(ctx, tx, b.OwnerID, b.NodeID, OpThumbnail, now)
		}
		return nil
	})
}

// ListIndexBlobs returns a page of a user's index segments, by id.
func (s *Store) ListIndexBlobs(ctx context.Context, ownerID, after string, limit int) ([]Blob, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT "+blobColumns+
		" FROM blobs WHERE owner_id = ? AND kind = ? AND id > ? ORDER BY id LIMIT ?", ownerID, BlobIndex, after, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list blobs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Blob
	for rows.Next() {
		b, err := scanBlob(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list blobs: %w", err)
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list blobs: %w", err)
	}
	return out, nil
}
