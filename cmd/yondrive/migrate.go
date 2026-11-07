package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"

	"github.com/Angelmmiguel/yondrive/internal/store"
)

// migrate reports or applies the schema migrations a data directory needs.
// serve applies them on start as well; this lets an operator check before an
// upgrade, or migrate with the server stopped and see the result.
func migrate(args []string) error {
	fs := flag.NewFlagSet("migrate", flag.ContinueOnError)
	fs.Usage = usage
	dataDir := fs.String("data", env("YONDRIVE_DATA", "./data"), "data directory")
	check := fs.Bool("check", false, "report only, without the lock and without writing")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 0 {
		usage()
		return errors.New("migrate: unexpected arguments")
	}
	return runMigrate(*dataDir, *check, os.Stdout)
}

// runMigrate fails when this binary cannot use the database at all: one written
// by a newer release, or one that will not open. A database with migrations
// pending is what an upgrade looks like, so --check reports it and succeeds.
func runMigrate(dataDir string, check bool, out io.Writer) error {
	have, want, err := store.SchemaVersion(dataDir)
	if errors.Is(err, fs.ErrNotExist) {
		_, err := fmt.Fprintf(out, "no database in %s: the server creates one at schema %d on its first start\n", dataDir, store.LatestSchema())
		return err
	}
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	switch {
	case have > want:
		return fmt.Errorf("migrate: %w: database at %d, binary at %d; run the release that wrote it, or a newer one", store.ErrSchemaTooNew, have, want)
	case have == want:
		_, err := fmt.Fprintf(out, "schema %d: up to date\n", have)
		return err
	case check:
		_, err := fmt.Fprintf(out, "schema %d, binary at %d: %d migrations to apply, which serve does on start\n", have, want, want-have)
		return err
	}
	st, err := store.Open(dataDir)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	if err := st.Close(); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	_, err = fmt.Fprintf(out, "schema %d: migrated from %d\n", want, have)
	return err
}
