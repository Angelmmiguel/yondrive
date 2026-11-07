package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Errors of versions. Callers match them with errors.Is.
var (
	// ErrVersionConflict means the node's current version is not the one the
	// caller started from.
	ErrVersionConflict = errors.New("store: current version has moved on")
	// ErrVersionCurrent means the version is the node's current one.
	ErrVersionCurrent = errors.New("store: version is current")
)

// Version is a state of a file's content. ContentVersionID is the id the blob
// was sealed and signed under, and ContentAuthorID who signed it; they differ
// from ID and AuthorID only on a restored version.
type Version struct {
	Seq              int64
	ID               string
	NodeID           string
	BlobID           string
	Suite            string
	AuthorID         string
	ContentVersionID string
	ContentAuthorID  string
	StoredSize       int64
	FrameCount       int64
	FrameSize        int64
	FrameHashes      []byte
	Signature        []byte
	Manifest         []byte
	CreatedAt        time.Time
	DeletedAt        time.Time
	RemoveAt         time.Time
}

// The list leaves out the frame hashes, which grow with the file.
const (
	versionSummaryColumns = `seq, id, node_id, blob_id, suite, author_id, content_version_id, content_author_id,
		stored_size, frame_count, frame_size, x'', signature, manifest, created_at, deleted_at, remove_at`
	versionColumns = `seq, id, node_id, blob_id, suite, author_id, content_version_id, content_author_id,
		stored_size, frame_count, frame_size, frame_hashes, signature, manifest, created_at, deleted_at, remove_at`
)

func scanVersion(row interface{ Scan(...any) error }) (Version, error) {
	var v Version
	var created int64
	var deleted, remove sql.NullInt64
	err := row.Scan(&v.Seq, &v.ID, &v.NodeID, &v.BlobID, &v.Suite, &v.AuthorID, &v.ContentVersionID, &v.ContentAuthorID,
		&v.StoredSize, &v.FrameCount, &v.FrameSize, &v.FrameHashes, &v.Signature, &v.Manifest, &created, &deleted, &remove)
	v.FrameHashes, v.Signature, v.Manifest = nonNil(v.FrameHashes), nonNil(v.Signature), nonNil(v.Manifest)
	v.CreatedAt = time.Unix(created, 0).UTC()
	v.DeletedAt, v.RemoveAt = fromNull(deleted), fromNull(remove)
	return v, err
}

// VersionByID returns a version of a node, or ErrNotFound.
func (s *Store) VersionByID(ctx context.Context, nodeID, id string) (Version, error) {
	return oneVersion(ctx, s.read, nodeID, id)
}

func oneVersion(ctx context.Context, q querier, nodeID, id string) (Version, error) {
	v, err := scanVersion(q.QueryRowContext(ctx, "SELECT "+versionColumns+" FROM versions WHERE node_id = ? AND id = ?", nodeID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Version{}, ErrNotFound
	}
	if err != nil {
		return Version{}, fmt.Errorf("store: read version: %w", err)
	}
	return v, nil
}

// ListVersions returns a page of a node's versions, newest first, before the
// sequence number given, or from the newest if it is zero. Versions marked for
// removal are in the list, so that they can still be restored.
func (s *Store) ListVersions(ctx context.Context, nodeID string, before int64, limit int) ([]Version, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT "+versionSummaryColumns+
		" FROM versions WHERE node_id = ? AND (? = 0 OR seq < ?) ORDER BY seq DESC LIMIT ?", nodeID, before, before, limit)
	if err != nil {
		return nil, fmt.Errorf("store: list versions: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []Version
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, fmt.Errorf("store: list versions: %w", err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list versions: %w", err)
	}
	return out, nil
}

// checkExpected compares a node's current version with what the caller started
// from. Nil asks for no check, and an empty string means no version yet.
func checkExpected(n Node, expected *string) error {
	if expected != nil && *expected != n.CurrentVersion {
		return ErrVersionConflict
	}
	return nil
}

// checkVersionIDFree refuses a version id that a version or an upload holds.
func checkVersionIDFree(ctx context.Context, q querier, id string) error {
	var exists int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM versions WHERE id = ?
		UNION ALL SELECT 1 FROM uploads WHERE version_id = ?`, id, id).Scan(&exists)
	if err == nil {
		return ErrIDTaken
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("store: check version id: %w", err)
	}
	return nil
}

// insertVersion adds a version, which takes a reference on its blob through a
// trigger, and makes it the node's current one.
func insertVersion(ctx context.Context, tx *sql.Tx, ownerID string, v Version) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO versions (id, node_id, blob_id, suite, author_id, content_version_id,
		content_author_id, stored_size, frame_count, frame_size, frame_hashes, signature, manifest, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		v.ID, v.NodeID, v.BlobID, v.Suite, v.AuthorID, v.ContentVersionID, v.ContentAuthorID,
		v.StoredSize, v.FrameCount, v.FrameSize, nonNil(v.FrameHashes), nonNil(v.Signature), nonNil(v.Manifest), v.CreatedAt.Unix())
	if err != nil {
		return fmt.Errorf("store: insert version: %w", err)
	}
	_, err = tx.ExecContext(ctx, "UPDATE nodes SET current_version = ?, updated_at = ? WHERE id = ?",
		v.ID, v.CreatedAt.Unix(), v.NodeID)
	if err != nil {
		return fmt.Errorf("store: set current version: %w", err)
	}
	return recordChange(ctx, tx, ownerID, v.NodeID, OpVersion, v.CreatedAt)
}

// RestoreVersion makes a new current version out of an older one: the same blob,
// with no copy, under one more reference. Its frames stay sealed and signed
// under the id they were written with, so that id, the signer and the manifest
// carry over. A version marked for removal can be restored until it goes.
func (s *Store) RestoreVersion(ctx context.Context, nodeID, sourceID, newID, authorID string, expected *string, now time.Time) (Version, error) {
	var out Version
	err := s.tx(ctx, func(tx *sql.Tx) error {
		n, err := oneNode(ctx, tx, "id = ?", nodeID)
		if err != nil {
			return err
		}
		if err := checkNotTrashed(ctx, tx, nodeID); err != nil {
			return err
		}
		source, err := oneVersion(ctx, tx, nodeID, sourceID)
		if err != nil {
			return err
		}
		if err := checkExpected(n, expected); err != nil {
			return err
		}
		if err := checkVersionIDFree(ctx, tx, newID); err != nil {
			return err
		}
		v := source
		v.ID, v.AuthorID, v.CreatedAt = newID, authorID, now
		if err := insertVersion(ctx, tx, n.OwnerID, v); err != nil {
			return err
		}
		out, err = oneVersion(ctx, tx, nodeID, newID)
		return err
	})
	return out, err
}

// DeleteVersion marks a version that is not current for removal at removeAt. Its
// blob stays, and stays counted, until then. An earlier mark stands.
func (s *Store) DeleteVersion(ctx context.Context, nodeID, id string, now, removeAt time.Time) (Version, error) {
	var out Version
	err := s.tx(ctx, func(tx *sql.Tx) error {
		n, err := oneNode(ctx, tx, "id = ?", nodeID)
		if err != nil {
			return err
		}
		v, err := oneVersion(ctx, tx, nodeID, id)
		if err != nil {
			return err
		}
		if n.CurrentVersion == id {
			return ErrVersionCurrent
		}
		if v.DeletedAt.IsZero() {
			_, err := tx.ExecContext(ctx, "UPDATE versions SET deleted_at = ?, remove_at = ? WHERE id = ?", now.Unix(), removeAt.Unix(), id)
			if err != nil {
				return fmt.Errorf("store: delete version: %w", err)
			}
			if err := recordChange(ctx, tx, n.OwnerID, nodeID, OpVersionDeleted, now); err != nil {
				return err
			}
		}
		out, err = oneVersion(ctx, tx, nodeID, id)
		return err
	})
	return out, err
}
