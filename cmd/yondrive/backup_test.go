package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

var t0 = time.Unix(1_800_000_000, 0).UTC()

// addUser adds a user that can act on the store directly.
func addUser(t *testing.T, st *store.Store, name string) store.User {
	t.Helper()
	u := store.User{ID: store.NewID(), Username: name, Role: "user", CreatedAt: t0}
	if err := st.CreateUser(context.Background(), u, "", t0); err != nil {
		t.Fatal(err)
	}
	return u
}

// addIndexBlob stores a real file and its row.
func addIndexBlob(t *testing.T, st *store.Store, dir *blobs.Dir, owner, content string) string {
	t.Helper()
	id := store.NewID()
	tmp, size, _, err := dir.WriteTemp(strings.NewReader(content), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	err = st.PutSmallBlob(context.Background(), store.Blob{ID: id, OwnerID: owner, Kind: store.BlobIndex, Suite: "none", Size: size, CreatedAt: t0},
		func() error { return dir.PlaceTemp(tmp, id) })
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestBackupRefuses(t *testing.T) {
	ctx := context.Background()
	if err := runBackup(ctx, t.TempDir(), filepath.Join(t.TempDir(), "b"), time.Now); err == nil {
		t.Error("backed up a directory with no database")
	}
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := runBackup(ctx, dir, filepath.Join(dir, "backup"), time.Now); err == nil {
		t.Error("backed up into the data directory")
	}
	if err := runBackup(ctx, dir, dir, time.Now); err == nil {
		t.Error("backed up onto the data directory")
	}
	if err := runBackup(ctx, dir, filepath.Dir(dir), time.Now); err == nil {
		t.Error("backed up over the parent of the data directory")
	}
	full := t.TempDir()
	if err := os.WriteFile(filepath.Join(full, "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runBackup(ctx, dir, full, time.Now); err == nil {
		t.Error("backed up over something")
	}
	stderr := os.Stderr
	devnull, _ := os.Open(os.DevNull)
	defer func() { _ = devnull.Close() }()
	os.Stderr = devnull
	defer func() { os.Stderr = stderr }()
	if err := backup([]string{"--data", dir}); err == nil {
		t.Error("no destination accepted")
	}
}

func TestWithin(t *testing.T) {
	for _, tc := range []struct {
		parent, path string
		want         bool
	}{
		{"/a", "/a", true}, {"/a", "/a/b", true}, {"/a", "/b", false}, {"/a", "/ab", false}, {"/a/b", "/a", false}, {"/a", "/a/..b", true},
	} {
		if got := within(tc.parent, tc.path); got != tc.want {
			t.Errorf("within(%q, %q) = %v", tc.parent, tc.path, got)
		}
	}
}

func TestBackupBesideARunningServerAndRestore(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	// The store holds the lock, as a live server does.
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	h := newHarness(t, st)
	h.setup()

	alice := h.signIn("root")
	rootID := alice.createRoot()
	file := alice.createFile(rootID, "file")
	content := bytes.Repeat([]byte("frame!"), 200)
	version := alice.upload(file, content)
	blobID := version["blob_id"].(string)

	// Something in flight, which the backup should drop.
	pending := alice.startUpload(file, content)

	// Keep writing throughout, as a live server would.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Go(func() {
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
				alice.createFile(rootID, "busy"+string(rune('a'+i%26))+time.Now().String())
			}
		}
	})

	dest := filepath.Join(t.TempDir(), "backup")
	at := t0.Add(time.Hour)
	err = runBackup(ctx, dir, dest, func() time.Time { return at })
	close(stop)
	wg.Wait()
	if err != nil {
		t.Fatalf("backup: %v", err)
	}

	got, err := st.Settings(ctx)
	if err != nil || !got.LastBackupAt.Equal(at) {
		t.Errorf("last backup = %v, %v", got.LastBackupAt, err)
	}
	resp := alice.call(http.MethodGet, "/api/v1/admin/health", nil)
	var health map[string]any
	if err := json.Unmarshal(resp, &health); err != nil {
		t.Fatal(err)
	}
	if health["last_backup_at"] != at.Format(time.RFC3339) {
		t.Errorf("health = %v", health)
	}

	// The source's files were not disturbed.
	if _, err := os.Stat(filepath.Join(dir, "blobs", blobID[:2], blobID)); err != nil {
		t.Errorf("source blob: %v", err)
	}
	h.close()

	// Restoring is starting a server on the directory.
	restored, err := store.Open(dest)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restored.Close() }()
	h2 := newHarness(t, restored)
	alice2 := h2.signIn("root")
	body := alice2.call(http.MethodGet, "/api/v1/blobs/"+blobID, nil)
	if !bytes.Equal(body, content) {
		t.Errorf("restored blob is %d bytes, want %d", len(body), len(content))
	}
	var page struct {
		Nodes []any `json:"nodes"`
	}
	if err := json.Unmarshal(alice2.call(http.MethodGet, "/api/v1/nodes/"+rootID+"/children", nil), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Nodes) == 0 {
		t.Error("the restored tree is empty")
	}
	// An upload in flight did not make it: its row is cleared and so is its room.
	if status := alice2.status(http.MethodGet, "/api/v1/uploads/"+pending); status != http.StatusNotFound {
		t.Errorf("upload after restore: %d", status)
	}
	var storage struct {
		Reserved int64 `json:"reserved_bytes"`
	}
	if err := json.Unmarshal(alice2.call(http.MethodGet, "/api/v1/me/storage", nil), &storage); err != nil {
		t.Fatal(err)
	}
	if storage.Reserved != 0 {
		t.Errorf("reserved after restore = %d", storage.Reserved)
	}
}

func TestBackupHoldsADatabaseAndItsFilesAlone(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	files, err := blobs.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	u := addUser(t, st, "alice")
	id := addIndexBlob(t, st, files, u.ID, "segment")
	dest := filepath.Join(t.TempDir(), "backup")
	if err := runBackup(ctx, dir, dest, time.Now); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(dest, "blobs", id[:2], id))
	if err != nil || string(got) != "segment" {
		t.Errorf("exported = %q, %v", got, err)
	}
	info, err := os.Stat(filepath.Join(dest, "yondrive.db"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("snapshot = %v, %v", info, err)
	}
	entries, err := os.ReadDir(dest)
	if err != nil || len(entries) != 2 {
		t.Errorf("backup holds %v, %v", entries, err)
	}
}

func TestBackupStartsOverWhenABlobGoesAway(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	files, err := blobs.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	u := addUser(t, st, "alice")
	gone := addIndexBlob(t, st, files, u.ID, "gone")
	kept := addIndexBlob(t, st, files, u.ID, "kept")
	dest := filepath.Join(t.TempDir(), "backup")

	// The file goes while its row is still there: the snapshot will name it.
	if err := files.RemoveBlob(gone); err != nil {
		t.Fatal(err)
	}
	if err := runBackup(ctx, dir, dest, time.Now); !errors.Is(err, blobs.ErrNotFound) {
		t.Fatalf("a blob missing for good: %v", err)
	}
	if got, _ := st.Settings(ctx); !got.LastBackupAt.IsZero() {
		t.Error("recorded a backup that failed")
	}
	if _, err := os.Stat(filepath.Join(dest, "yondrive.db")); err == nil {
		t.Error("a failed backup looks complete")
	}

	// Once its row has gone too, the next attempt gets a snapshot without it, and
	// clears what the last attempt copied.
	if err := st.DeleteSmallBlob(ctx, gone, t0); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dest, "blobs", "ff", "ff"+strings.Repeat("0", 30))
	if err := os.MkdirAll(filepath.Dir(stale), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	source, err := store.OpenLive(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = source.Close() }()
	if err := backupOnce(ctx, source, files, dest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); err == nil {
		t.Error("a stale file stayed in the backup")
	}
	if got, err := os.ReadFile(filepath.Join(dest, "blobs", kept[:2], kept)); err != nil || string(got) != "kept" {
		t.Errorf("kept = %q, %v", got, err)
	}
}

// harness is a server over a store, for tests that need the whole path.
type harness struct {
	t   *testing.T
	st  *store.Store
	srv *httptest.Server
}

func newHarness(t *testing.T, st *store.Store) *harness {
	t.Helper()
	srv, err := server.New(server.Config{
		SetupToken: "tok",
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, st)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, st: st, srv: httptest.NewServer(srv)}
	t.Cleanup(h.srv.Close)
	return h
}

func (h *harness) close() { h.srv.Close() }

func (h *harness) setup() {
	h.t.Helper()
	salt := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 16))
	authKey := base64.StdEncoding.EncodeToString(auth.HashToken("root"))
	body, _ := json.Marshal(map[string]any{
		"settings": map[string]any{"name": "Home", "public_url": "http://x", "default_quota_bytes": 0, "language": "en", "time_zone": "UTC", "mode": "none"},
		"admin":    map[string]any{"username": "root", "auth_key": authKey, "kdf": map[string]any{"name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": salt}},
	})
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/v1/setup/complete", bytes.NewReader(body))
	req.Header.Set("X-Setup-Token", "tok")
	resp, err := h.srv.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		h.t.Fatalf("setup: %d", resp.StatusCode)
	}
}

type signedIn struct {
	h      *harness
	cookie string
}

func (h *harness) signIn(username string) *signedIn {
	h.t.Helper()
	authKey := base64.StdEncoding.EncodeToString(auth.HashToken(username))
	body, _ := json.Marshal(map[string]any{"username": username, "auth_key": authKey})
	resp, err := h.srv.Client().Post(h.srv.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("login: %d", resp.StatusCode)
	}
	for _, c := range resp.Cookies() {
		if c.Name == "yondrive_session" {
			return &signedIn{h: h, cookie: c.Name + "=" + c.Value}
		}
	}
	h.t.Fatal("no cookie")
	return nil
}

func (s *signedIn) do(method, path string, body []byte, header ...string) (int, []byte) {
	s.h.t.Helper()
	req, err := http.NewRequest(method, s.h.srv.URL+path, bytes.NewReader(body))
	if err != nil {
		s.h.t.Fatal(err)
	}
	req.Header.Set("Cookie", s.cookie)
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	resp, err := s.h.srv.Client().Do(req)
	if err != nil {
		s.h.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		s.h.t.Fatal(err)
	}
	return resp.StatusCode, data
}

func (s *signedIn) call(method, path string, body any) []byte {
	s.h.t.Helper()
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	status, out := s.do(method, path, data)
	if status >= 300 {
		s.h.t.Errorf("%s %s: %d %s", method, path, status, out)
	}
	return out
}

func (s *signedIn) status(method, path string) int {
	status, _ := s.do(method, path, nil)
	return status
}

func (s *signedIn) id(data []byte) string {
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		s.h.t.Fatal(err)
	}
	return out.ID
}

func (s *signedIn) createRoot() string {
	return s.id(s.call(http.MethodPost, "/api/v1/nodes/root", map[string]any{"id": store.NewID(), "suite": "none", "wrapped_key": ""}))
}

func (s *signedIn) createFile(parent, name string) string {
	sum := sha256.Sum256([]byte(name))
	return s.id(s.call(http.MethodPost, "/api/v1/nodes", map[string]any{
		"id": store.NewID(), "parent_id": parent, "kind": "file", "suite": "none",
		"sealed_metadata": base64.StdEncoding.EncodeToString([]byte("{}")), "wrapped_key": "",
		"name_tag": base64.StdEncoding.EncodeToString(sum[:]),
	}))
}

func (s *signedIn) startUpload(node string, content []byte) string {
	return s.id(s.call(http.MethodPost, "/api/v1/uploads", map[string]any{
		"node_id": node, "version_id": store.NewID(), "suite": "none",
		"frame_count": 1, "frame_size": 4096, "stored_size": len(content),
	}))
}

func (s *signedIn) upload(node string, content []byte) map[string]any {
	s.h.t.Helper()
	id := s.startUpload(node, content)
	sum := sha256.Sum256(content)
	status, out := s.do(http.MethodPut, "/api/v1/uploads/"+id+"/frames/0", content, "X-Content-SHA256", base64.StdEncoding.EncodeToString(sum[:]))
	if status != http.StatusNoContent {
		s.h.t.Fatalf("frame: %d %s", status, out)
	}
	var version map[string]any
	data := s.call(http.MethodPost, "/api/v1/uploads/"+id+"/commit", map[string]any{"signature": "", "manifest": base64.StdEncoding.EncodeToString([]byte("m"))})
	if err := json.Unmarshal(data, &version); err != nil {
		s.h.t.Fatal(err)
	}
	return version
}

func TestBackupOfAServerWithNothingStored(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	dest := filepath.Join(t.TempDir(), "backup")
	if err := runBackup(context.Background(), dir, dest, time.Now); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Open(dest)
	if err != nil {
		t.Fatal(err)
	}
	_ = restored.Close()
}
