package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// snapshotSuffix marks a snapshot that is not yet a finished backup.
const snapshotSuffix = ".tmp"

// Live is a handle on a database file, for `yondrive backup`. Unlike Open it takes
// no lock, because the point is to work beside a running server, and it applies no
// migrations, because that is for the server to do. SQLite's own locks make the
// two safe together.
type Live struct {
	db *sql.DB
}

// OpenLive opens the database of an existing data directory. It fails if there is
// none, or if its schema is not exactly the one this binary knows.
func OpenLive(dir string) (*Live, error) {
	return openLive(filepath.Join(dir, dbFile))
}

// OpenSnapshot opens the snapshot that Snapshot left in a directory.
func OpenSnapshot(dir string) (*Live, error) {
	return openLive(filepath.Join(dir, dbFile+snapshotSuffix))
}

func openLive(path string) (*Live, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("store: open database: %w", err)
	}
	db, err := sql.Open("sqlite", dsn(path, "mode=rw", "_txlock=immediate"))
	if err != nil {
		return nil, fmt.Errorf("store: open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	l := &Live{db: db}
	if err := l.checkSchema(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return l, nil
}

func (l *Live) checkSchema(ctx context.Context) error {
	var current int
	if err := l.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("store: read schema version: %w", err)
	}
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return fmt.Errorf("store: list migrations: %w", err)
	}
	if current > len(entries) {
		return fmt.Errorf("%w: database at %d, binary at %d", ErrSchemaTooNew, current, len(entries))
	}
	if current < len(entries) {
		return fmt.Errorf("%w: database at %d, binary at %d", ErrSchemaTooOld, current, len(entries))
	}
	return nil
}

// Close releases the handle.
func (l *Live) Close() error { return l.db.Close() }

// Snapshot writes a consistent copy of the database, as of one moment, into dir.
// Commits go on meanwhile and are not in it. It stays under a temporary name until
// FinishSnapshot, so that a directory holding a database is a complete backup.
func (l *Live) Snapshot(ctx context.Context, dir string) error {
	tmp := filepath.Join(dir, dbFile+snapshotSuffix)
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("store: clear snapshot: %w", err)
	}
	if _, err := l.db.ExecContext(ctx, "VACUUM INTO ?", tmp); err != nil {
		return fmt.Errorf("store: snapshot database: %w", err)
	}
	if err := forgetServerSecret(ctx, tmp); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("store: open snapshot: %w", err)
	}
	if err := errors.Join(f.Chmod(0o600), f.Sync(), f.Close()); err != nil {
		return fmt.Errorf("store: sync snapshot: %w", err)
	}
	return nil
}

// forgetServerSecret deletes the server secret from a copy of the database. The
// secret signs link tokens and sealed sign-in flows, so a copy that kept it
// would let whoever holds the copy sign a token for any live link, with a
// password or not. A server started on the copy makes a new one. The row is
// overwritten rather than only unlinked, and the edit keeps no journal on disk,
// so the value is left neither in a free page nor in a journal file.
func forgetServerSecret(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", dsn(path, "mode=rw", "_pragma=journal_mode(MEMORY)", "_pragma=secure_delete(1)"))
	if err != nil {
		return fmt.Errorf("store: open copy: %w", err)
	}
	db.SetMaxOpenConns(1)
	_, err = db.ExecContext(ctx, "DELETE FROM settings WHERE key = ?", keyServerSecret)
	if err = errors.Join(err, db.Close()); err != nil {
		return fmt.Errorf("store: forget the server secret: %w", err)
	}
	return nil
}

// FinishSnapshot gives a snapshot its final name, once everything it refers to is
// in place. The caller closes any handle on the snapshot first and syncs dir after.
func FinishSnapshot(dir string) error {
	if err := os.Rename(filepath.Join(dir, dbFile+snapshotSuffix), filepath.Join(dir, dbFile)); err != nil {
		return fmt.Errorf("store: place snapshot: %w", err)
	}
	return nil
}

// BlobIDs returns the id of every blob.
func (l *Live) BlobIDs(ctx context.Context) ([]string, error) {
	rows, err := l.db.QueryContext(ctx, "SELECT id FROM blobs")
	if err != nil {
		return nil, fmt.Errorf("store: list blobs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("store: list blobs: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("store: list blobs: %w", err)
	}
	return ids, nil
}

// RecordBackup stores the time of a finished backup, for the admin to see.
func (l *Live) RecordBackup(ctx context.Context, at time.Time) error {
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := putSetting(ctx, tx, keyLastBackup, strconv.FormatInt(at.Unix(), 10)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit: %w", err)
	}
	return nil
}
