package main

import (
	"bytes"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Angelmmiguel/yondrive/internal/store"
)

func TestMigrate(t *testing.T) {
	var out bytes.Buffer
	dir := t.TempDir()
	if err := runMigrate(dir, true, &out); err != nil || !strings.Contains(out.String(), "no database") {
		t.Errorf("empty directory: %v %q", err, out.String())
	}

	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Beside a running server, --check reads without the lock.
	out.Reset()
	if err := runMigrate(dir, true, &out); err != nil || !strings.Contains(out.String(), "up to date") {
		t.Errorf("current schema: %v %q", err, out.String())
	}
	// Migrating needs the server stopped.
	setUserVersion(t, filepath.Join(dir, "yondrive.db"), store.LatestSchema()-1)
	if err := runMigrate(dir, false, &out); !errors.Is(err, store.ErrLocked) {
		t.Errorf("migrate beside a server: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	// Stamped one behind, as after an upgrade: --check reports it and runs nothing.
	out.Reset()
	if err := runMigrate(dir, true, &out); err != nil || !strings.Contains(out.String(), "1 migrations to apply") {
		t.Errorf("pending: %v %q", err, out.String())
	}

	setUserVersion(t, filepath.Join(dir, "yondrive.db"), store.LatestSchema()+1)
	if err := runMigrate(dir, true, &out); !errors.Is(err, store.ErrSchemaTooNew) {
		t.Errorf("newer schema, checked: %v", err)
	}
	if err := runMigrate(dir, false, &out); !errors.Is(err, store.ErrSchemaTooNew) {
		t.Errorf("newer schema, migrated: %v", err)
	}
}

func TestMigrateApplies(t *testing.T) {
	// A database at schema 0, as SQLite makes it, takes every migration.
	dir := t.TempDir()
	setUserVersion(t, filepath.Join(dir, "yondrive.db"), 0)
	var out bytes.Buffer
	want := "schema " + strconv.Itoa(store.LatestSchema()) + ": migrated from 0"
	if err := runMigrate(dir, false, &out); err != nil || !strings.Contains(out.String(), want) {
		t.Errorf("migrate: %v %q", err, out.String())
	}
	out.Reset()
	if err := runMigrate(dir, true, &out); err != nil || !strings.Contains(out.String(), "up to date") {
		t.Errorf("after migrating: %v %q", err, out.String())
	}
}
