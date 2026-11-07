package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// backupAttempts is how many times a backup starts over because a file went away
// under it. Each attempt keeps the files of the last, so they get quicker.
const backupAttempts = 5

// backup takes a consistent snapshot of the data directory, beside a running
// server or not.
func backup(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	fs.Usage = usage
	dataDir := fs.String("data", env("YONDRIVE_DATA", "./data"), "data directory")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		usage()
		return errors.New("backup: name one destination")
	}
	return runBackup(context.Background(), *dataDir, fs.Arg(0), time.Now)
}

// runBackup copies the database as of one moment, then the files that moment
// refers to, in that order.
//
// A blob is a file that never changes, and goes only after its row, so every row
// in the snapshot means a file that was there when the snapshot was taken. The
// server may remove one before it is copied: that needs the row deleted first,
// which the grace period makes rare and nothing makes impossible, so the whole
// thing starts over with a newer snapshot.
func runBackup(ctx context.Context, dataDir, dest string, now func() time.Time) error {
	dest, err := filepath.Abs(dest)
	if err != nil {
		return fmt.Errorf("backup: destination: %w", err)
	}
	if err := checkBackupDest(dataDir, dest); err != nil {
		return err
	}
	source, err := store.OpenLive(dataDir)
	if err != nil {
		return err
	}
	defer func() { _ = source.Close() }()
	files, err := blobs.Open(dataDir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return fmt.Errorf("backup: destination: %w", err)
	}
	for attempt := 1; ; attempt++ {
		err := backupOnce(ctx, source, files, dest)
		if err == nil {
			break
		}
		if !errors.Is(err, blobs.ErrNotFound) || attempt == backupAttempts {
			return err
		}
	}
	if err := blobs.SyncExport(dest); err != nil {
		return err
	}
	if err := store.FinishSnapshot(dest); err != nil {
		return err
	}
	if err := blobs.SyncExport(dest); err != nil {
		return err
	}
	return source.RecordBackup(ctx, now())
}

func backupOnce(ctx context.Context, source *store.Live, files *blobs.Dir, dest string) error {
	if err := source.Snapshot(ctx, dest); err != nil {
		return err
	}
	snapshot, err := store.OpenSnapshot(dest)
	if err != nil {
		return err
	}
	defer func() { _ = snapshot.Close() }()
	ids, err := snapshot.BlobIDs(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := files.Export(id, dest); err != nil {
			return fmt.Errorf("backup: blob %s: %w", id, err)
		}
	}
	// What an earlier attempt copied and this snapshot no longer has.
	slices.Sort(ids)
	exported := blobs.At(dest)
	return exported.EachShard(func(_ string, onDisk []string) error {
		for _, id := range onDisk {
			if _, found := slices.BinarySearch(ids, id); !found {
				if err := exported.RemoveBlob(id); err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// checkBackupDest refuses a destination inside the data directory, or the other
// way round, and one with something in it: a backup is one consistent moment, and
// restoring it means using the directory as it stands. dest is absolute.
func checkBackupDest(dataDir, dest string) error {
	src, err := filepath.Abs(dataDir)
	if err != nil {
		return fmt.Errorf("backup: data directory: %w", err)
	}
	if within(src, dest) || within(dest, src) {
		return errors.New("backup: the destination and the data directory must not contain each other")
	}
	entries, err := os.ReadDir(dest)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("backup: destination: %w", err)
	}
	if len(entries) > 0 {
		return fmt.Errorf("backup: destination %s is not empty", dest)
	}
	return nil
}

func within(parent, path string) bool {
	rel, err := filepath.Rel(parent, path)
	return err == nil && (rel == "." || !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..")
}
