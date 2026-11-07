package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// SchemaVersion reports the schema version of the database in a data
// directory, and the one this binary migrates to. It reads without the lock or
// any write, so it works beside a running server. It fails with an error
// matching fs.ErrNotExist if the directory has no database.
func SchemaVersion(dir string) (have, want int, err error) {
	names, err := migrationNames()
	if err != nil {
		return 0, 0, err
	}
	db, err := openReadOnly(filepath.Join(dir, dbFile))
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = db.Close() }()
	if err := db.QueryRow("PRAGMA user_version").Scan(&have); err != nil {
		return 0, 0, fmt.Errorf("store: read schema version: %w", err)
	}
	return have, len(names), nil
}

// RestoreDatabase writes the database of a finished backup into an empty data
// directory, through SQLite so the copy is whole and checked as it is read. A
// schema newer than this binary's is refused; an older one is left for the
// server to migrate when it starts. The backup is not written to.
func RestoreDatabase(ctx context.Context, backupDir, dataDir string) error {
	have, want, err := SchemaVersion(backupDir)
	if err != nil {
		return err
	}
	if have > want {
		return fmt.Errorf("%w: backup at %d, binary at %d", ErrSchemaTooNew, have, want)
	}
	db, err := openReadOnly(filepath.Join(backupDir, dbFile))
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	var check string
	if err := db.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&check); err != nil {
		return fmt.Errorf("store: check the backup's database: %w", err)
	}
	if check != "ok" {
		return fmt.Errorf("store: the backup's database is damaged: %s", check)
	}
	tmp := filepath.Join(dataDir, dbFile+snapshotSuffix)
	if err := os.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("store: clear restore: %w", err)
	}
	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", tmp); err != nil {
		return fmt.Errorf("store: copy database: %w", err)
	}
	// A backup taken before backups left the secret out still has it.
	if err := forgetServerSecret(ctx, tmp); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_RDWR, 0)
	if err != nil {
		return fmt.Errorf("store: open restored database: %w", err)
	}
	if err := errors.Join(f.Chmod(0o600), f.Sync(), f.Close()); err != nil {
		return fmt.Errorf("store: sync restored database: %w", err)
	}
	return FinishSnapshot(dataDir)
}

func openReadOnly(path string) (*sql.DB, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("store: open database: %w", err)
	}
	db, err := sql.Open("sqlite", dsn(path, "mode=ro"))
	if err != nil {
		return nil, fmt.Errorf("store: open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// LatestSchema is the schema version this binary migrates a database to.
func LatestSchema() int {
	names, err := migrationNames()
	if err != nil {
		// The migrations are compiled in; failing to list them is a broken binary.
		panic(err)
	}
	return len(names)
}
