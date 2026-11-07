package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// restore puts a backup into a new data directory, leaving the backup as it was.
func restore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	fs.Usage = usage
	dataDir := fs.String("data", env("YONDRIVE_DATA", "./data"), "data directory to create")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		usage()
		return errors.New("restore: name one backup")
	}
	return runRestore(context.Background(), fs.Arg(0), *dataDir)
}

// runRestore copies a finished backup into a data directory that is empty or
// does not exist. It never writes over an existing one: merging two moments of
// a server would give a state neither had. Files go first and the database
// last, so a directory without yondrive.db is an unfinished restore, as it is an
// unfinished backup.
func runRestore(ctx context.Context, backupDir, dataDir string) error {
	src, err := filepath.Abs(backupDir)
	if err != nil {
		return fmt.Errorf("restore: backup: %w", err)
	}
	dest, err := filepath.Abs(dataDir)
	if err != nil {
		return fmt.Errorf("restore: data directory: %w", err)
	}
	if within(src, dest) || within(dest, src) {
		return errors.New("restore: the backup and the data directory must not contain each other")
	}
	if _, err := os.Stat(filepath.Join(src, "yondrive.db")); err != nil {
		return fmt.Errorf("restore: %s is not a finished backup: %w", src, err)
	}
	if err := checkEmpty(dest); err != nil {
		return err
	}
	// Read before anything is written, so a backup this binary cannot use leaves
	// nothing behind.
	if have, want, err := store.SchemaVersion(src); err != nil {
		return fmt.Errorf("restore: %w", err)
	} else if have > want {
		return fmt.Errorf("restore: %w: backup at %d, binary at %d", store.ErrSchemaTooNew, have, want)
	}
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return fmt.Errorf("restore: data directory: %w", err)
	}
	backup := blobs.At(src)
	err = backup.EachShard(func(_ string, ids []string) error {
		for _, id := range ids {
			if err := backup.Export(id, dest); err != nil {
				return fmt.Errorf("restore: blob %s: %w", id, err)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := blobs.SyncExport(dest); err != nil {
		return err
	}
	if err := store.RestoreDatabase(ctx, src, dest); err != nil {
		return fmt.Errorf("restore: %w", err)
	}
	return blobs.SyncExport(dest)
}

// checkEmpty refuses a data directory with anything in it.
func checkEmpty(dir string) error {
	d, err := os.Open(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("restore: data directory: %w", err)
	}
	defer func() { _ = d.Close() }()
	if _, err := d.Readdirnames(1); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("restore: data directory %s is not empty; restore into a new one", dir)
		}
		return fmt.Errorf("restore: data directory: %w", err)
	}
	return nil
}
