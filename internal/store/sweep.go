package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// MarkExpiredTrash marks for removal what has been in the trash since before
// cutoff, and returns how many nodes it marked. Nothing about these differs from
// a client's own purge: the grace period follows.
func (s *Store) MarkExpiredTrash(ctx context.Context, cutoff, now, removeAt time.Time) (int, error) {
	var marked int
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var err error
		marked, err = markPurged(ctx, tx, "trashed_at IS NOT NULL AND purged_at IS NULL AND trashed_at < ?", now, removeAt, cutoff.Unix())
		return err
	})
	return marked, err
}

// RemoveDueNodes deletes up to limit subtrees whose grace period is over and
// returns how many. Cascades take everything under them and the triggers queue
// the files.
func (s *Store) RemoveDueNodes(ctx context.Context, now time.Time, limit int) (int, error) {
	var removed int
	err := s.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, "SELECT id, owner_id FROM nodes WHERE remove_at IS NOT NULL AND remove_at <= ? LIMIT ?", now.Unix(), limit)
		if err != nil {
			return fmt.Errorf("store: list due nodes: %w", err)
		}
		type due struct{ id, owner string }
		var nodes []due
		for rows.Next() {
			var d due
			if err := rows.Scan(&d.id, &d.owner); err != nil {
				_ = rows.Close()
				return fmt.Errorf("store: list due nodes: %w", err)
			}
			nodes = append(nodes, d)
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return fmt.Errorf("store: list due nodes: %w", err)
		}
		for _, d := range nodes {
			// One due node can have gone with a due folder above it.
			var exists int
			err := tx.QueryRowContext(ctx, "SELECT 1 FROM nodes WHERE id = ?", d.id).Scan(&exists)
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			if err != nil {
				return fmt.Errorf("store: remove node: %w", err)
			}
			// While the node is there, so that the journal can tell who reaches it.
			if err := recordChange(ctx, tx, d.owner, d.id, OpRemoved, now); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM nodes WHERE id = ?", d.id); err != nil {
				return fmt.Errorf("store: remove node: %w", err)
			}
			removed++
		}
		return nil
	})
	return removed, err
}

// RemoveDueVersions deletes up to limit versions whose grace period is over and
// returns how many. A blob goes with the last version that references it.
func (s *Store) RemoveDueVersions(ctx context.Context, now time.Time, limit int) (int64, error) {
	res, err := s.write.ExecContext(ctx, `DELETE FROM versions WHERE seq IN (
		SELECT seq FROM versions WHERE remove_at IS NOT NULL AND remove_at <= ? LIMIT ?)`, now.Unix(), limit)
	if err != nil {
		return 0, fmt.Errorf("store: remove versions: %w", err)
	}
	return res.RowsAffected()
}

// RemoveStaleUploads deletes up to limit uploads untouched since before cutoff,
// which releases their reservations, and returns how many.
func (s *Store) RemoveStaleUploads(ctx context.Context, cutoff time.Time, limit int) (int64, error) {
	res, err := s.write.ExecContext(ctx, `DELETE FROM uploads WHERE id IN (
		SELECT id FROM uploads WHERE updated_at < ? LIMIT ?)`, cutoff.Unix(), limit)
	if err != nil {
		return 0, fmt.Errorf("store: remove uploads: %w", err)
	}
	return res.RowsAffected()
}

// Kinds of file removal.
const (
	RemoveBlob   = "blob"
	RemoveUpload = "upload"
)

// FileRemoval is a file whose row has gone and whose bytes have not.
type FileRemoval struct {
	Kind string
	ID   string
}

// PendingFileRemovals returns up to limit files waiting to be unlinked.
func (s *Store) PendingFileRemovals(ctx context.Context, limit int) ([]FileRemoval, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT kind, id FROM file_removals LIMIT ?", limit)
	if err != nil {
		return nil, fmt.Errorf("store: list removals: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []FileRemoval
	for rows.Next() {
		var r FileRemoval
		if err := rows.Scan(&r.Kind, &r.ID); err != nil {
			return nil, fmt.Errorf("store: list removals: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list removals: %w", err)
	}
	return out, nil
}

// ClearFileRemoval forgets a removal, once its file is gone.
func (s *Store) ClearFileRemoval(ctx context.Context, r FileRemoval) error {
	_, err := s.write.ExecContext(ctx, "DELETE FROM file_removals WHERE kind = ? AND id = ?", r.Kind, r.ID)
	if err != nil {
		return fmt.Errorf("store: clear removal: %w", err)
	}
	return nil
}

// BlobIDsInShard returns the ids of the blobs whose ids start with shard. The
// check at startup goes through the directory one shard at a time, so it never
// needs every id in memory.
func (s *Store) BlobIDsInShard(ctx context.Context, shard string) (map[string]bool, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT id FROM blobs WHERE id >= ? AND id < ? || 'g'", shard, shard)
	if err != nil {
		return nil, fmt.Errorf("store: list blobs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	ids := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("store: list blobs: %w", err)
		}
		ids[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list blobs: %w", err)
	}
	return ids, nil
}

// UploadIDs returns the ids of every upload in progress.
func (s *Store) UploadIDs(ctx context.Context) (map[string]bool, error) {
	rows, err := s.read.QueryContext(ctx, "SELECT id FROM uploads")
	if err != nil {
		return nil, fmt.Errorf("store: list uploads: %w", err)
	}
	defer func() { _ = rows.Close() }()
	ids := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("store: list uploads: %w", err)
		}
		ids[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list uploads: %w", err)
	}
	return ids, nil
}

// StorageStats are the server-wide figures of the admin health view.
type StorageStats struct {
	Blobs           int64
	StoredBytes     int64
	Uploads         int64
	ReservedBytes   int64
	PendingRemovals int64
	AuditEntries    int64
	JournalEntries  int64
}

// Stats returns the server-wide storage figures.
func (s *Store) Stats(ctx context.Context) (StorageStats, error) {
	var st StorageStats
	err := s.read.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM blobs), (SELECT coalesce(sum(size), 0) FROM blobs),
		(SELECT count(*) FROM uploads), (SELECT coalesce(sum(stored_size), 0) FROM uploads),
		(SELECT count(*) FROM file_removals),
		(SELECT count(*) FROM audit), (SELECT count(*) FROM changes)`).
		Scan(&st.Blobs, &st.StoredBytes, &st.Uploads, &st.ReservedBytes, &st.PendingRemovals, &st.AuditEntries, &st.JournalEntries)
	if err != nil {
		return StorageStats{}, fmt.Errorf("store: read stats: %w", err)
	}
	return st, nil
}
