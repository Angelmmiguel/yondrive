// Package store keeps YonDrive's metadata in a SQLite database inside the data
// directory. It knows how to read and write records atomically and nothing
// about what they mean: callers decide who may do what.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"syscall"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// Names of the files the store owns in the data directory.
const (
	dbFile   = "yondrive.db"
	lockFile = "lock"
)

// busyTimeoutMillis bounds how long a statement waits for a competing
// connection before failing.
const busyTimeoutMillis = 5000

// Errors returned by the store. Callers match them with errors.Is.
var (
	// ErrLocked means another process holds the data directory.
	ErrLocked = errors.New("store: data directory is in use by another process")
	// ErrSchemaTooNew means the database was written by a newer binary.
	ErrSchemaTooNew = errors.New("store: database schema is newer than this binary")
	// ErrNotFound means the record does not exist.
	ErrNotFound = errors.New("store: not found")
	// ErrNotConfigured means setup has not been completed.
	ErrNotConfigured = errors.New("store: server is not configured")
	// ErrAlreadyConfigured means setup was completed before.
	ErrAlreadyConfigured = errors.New("store: server is already configured")
	// ErrUsernameTaken means another user holds the username.
	ErrUsernameTaken = errors.New("store: username is taken")
	// ErrEmailTaken means another user holds the email address.
	ErrEmailTaken = errors.New("store: email is taken")
	// ErrInviteInvalid means the invite is unknown, used or expired.
	ErrInviteInvalid = errors.New("store: invite is not valid")
	// ErrResetInvalid means the password reset is unknown or expired.
	ErrResetInvalid = errors.New("store: password reset is not valid")
)

//go:embed migrations/*.sql
var migrations embed.FS

// Store is the metadata database. All writes go through one connection, so a
// write transaction never waits on another; reads use their own pool and see
// the last committed state.
type Store struct {
	write *sql.DB
	read  *sql.DB
	lock  *os.File
}

// Open creates the data directory if needed, takes its advisory lock and opens
// the database, applying any pending migrations. It fails with ErrLocked if
// another process has the directory.
func Open(dir string) (_ *Store, err error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: data directory: %w", err)
	}
	lock, err := acquireLock(filepath.Join(dir, lockFile))
	if err != nil {
		return nil, err
	}
	st := &Store{lock: lock}
	defer func() {
		if err != nil {
			_ = st.Close()
		}
	}()

	path := filepath.Join(dir, dbFile)
	// The WAL and shared-memory files take their mode from this one.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("store: create database: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("store: create database: %w", err)
	}
	if st.write, err = sql.Open("sqlite", dsn(path, "_txlock=immediate", "_pragma=journal_mode(WAL)", "_pragma=synchronous(NORMAL)")); err != nil {
		return nil, fmt.Errorf("store: open database: %w", err)
	}
	st.write.SetMaxOpenConns(1)
	if st.read, err = sql.Open("sqlite", dsn(path, "_pragma=query_only(1)")); err != nil {
		return nil, fmt.Errorf("store: open database: %w", err)
	}
	if err := st.migrate(); err != nil {
		return nil, err
	}
	return st, nil
}

// Close releases the database and the lock.
func (s *Store) Close() error {
	var errs []error
	for _, db := range []*sql.DB{s.read, s.write} {
		if db != nil {
			errs = append(errs, db.Close())
		}
	}
	// Closing the file releases the flock.
	errs = append(errs, s.lock.Close())
	return errors.Join(errs...)
}

func acquireLock(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("store: open lock: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil { //nolint:gosec // a file descriptor fits an int
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("store: take lock: %w", err)
	}
	return f, nil
}

func dsn(path string, options ...string) string {
	query := "_pragma=busy_timeout(" + strconv.Itoa(busyTimeoutMillis) + ")&_pragma=foreign_keys(1)"
	for _, o := range options {
		query += "&" + o
	}
	return (&url.URL{Scheme: "file", Path: path, RawQuery: query}).String()
}

// migrate applies the embedded migrations newer than the database's
// user_version, each in its own transaction with the version bump.
func (s *Store) migrate() error {
	ctx := context.Background()
	var current int
	if err := s.write.QueryRowContext(ctx, "PRAGMA user_version").Scan(&current); err != nil {
		return fmt.Errorf("store: read schema version: %w", err)
	}
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		return fmt.Errorf("store: list migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	slices.Sort(names)
	if current > len(names) {
		return fmt.Errorf("%w: database at %d, binary at %d", ErrSchemaTooNew, current, len(names))
	}
	for i := current; i < len(names); i++ {
		body, err := migrations.ReadFile("migrations/" + names[i])
		if err != nil {
			return fmt.Errorf("store: read migration: %w", err)
		}
		err = s.tx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, string(body)); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, "PRAGMA user_version = "+strconv.Itoa(i+1))
			return err
		})
		if err != nil {
			return fmt.Errorf("store: migration %s: %w", names[i], err)
		}
	}
	return nil
}

// tx runs fn in a write transaction, committing if it returns nil.
func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.write.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("store: commit: %w", err)
	}
	return nil
}

// NewID returns a random record id: 32 lowercase hex characters.
func NewID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
