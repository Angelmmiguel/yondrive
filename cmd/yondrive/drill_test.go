package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// The backup and restore drill: a server with real content in each mode, a backup
// taken while it serves and writes, a restore into a new directory, and a server
// on that directory that has everything back. The browser drill
// (web/tests/e2e/backup-drill.spec.ts) does the same through the app, with the
// zero knowledge canary.

const e2eSuite = "xchacha20poly1305-v1"

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func fill(v byte, n int) []byte { return bytes.Repeat([]byte{v}, n) }

// opaque stands in for what a client seals in end-to-end mode, and is empty
// without encryption, as the server expects in each.
func opaque(mode string, v byte, n int) string {
	if mode == "e2e" {
		return b64(fill(v, n))
	}
	return ""
}

func suiteOf(mode string) string {
	if mode == "e2e" {
		return e2eSuite
	}
	return "none"
}

// newAccount is a new account whose auth key is auth.HashToken(username).
func newAccount(username, mode string) map[string]any {
	a := map[string]any{
		"username": username,
		"auth_key": b64(auth.HashToken(username)),
		"kdf":      map[string]any{"name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": b64(fill(1, 16))},
	}
	if mode == "e2e" {
		a["recovery_auth_key"] = b64(auth.HashToken(username + "-recovery"))
		a["keys"] = map[string]any{
			"wrapped_master_key":          b64(fill(10, 72)),
			"wrapped_master_key_recovery": b64(fill(11, 72)),
			"sealed_x25519":               b64(fill(12, 72)),
			"sealed_ed25519":              b64(fill(13, 72)),
			"public_keys":                 map[string]any{"x25519": b64(fill(14, 32)), "ed25519": b64(fill(15, 32))},
		}
	}
	return a
}

// drillUser is a signed-in user who makes requests in the server's mode.
type drillUser struct {
	*signedIn
	mode   string
	userID string
}

func (h *harness) drillUser(username, mode string) *drillUser {
	h.t.Helper()
	s := h.signIn(username)
	var me struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(s.call(http.MethodGet, "/api/v1/me", nil), &me); err != nil {
		h.t.Fatal(err)
	}
	return &drillUser{signedIn: s, mode: mode, userID: me.User.ID}
}

func (u *drillUser) root() string {
	u.h.t.Helper()
	status, out := u.do(http.MethodPost, "/api/v1/nodes/root", mustJSON(map[string]any{
		"id": store.NewID(), "suite": suiteOf(u.mode), "wrapped_key": opaque(u.mode, 7, 73),
	}))
	if status != http.StatusCreated && status != http.StatusOK {
		u.h.t.Fatalf("root: %d %s", status, out)
	}
	return u.id(out)
}

func (u *drillUser) node(parent, kind, name string, metadata []byte) string {
	tag := auth.HashToken(name)
	return u.id(u.call(http.MethodPost, "/api/v1/nodes", map[string]any{
		"id": store.NewID(), "parent_id": parent, "kind": kind, "suite": suiteOf(u.mode),
		"sealed_metadata": b64(metadata), "wrapped_key": opaque(u.mode, 7, 73), "name_tag": b64(tag),
	}))
}

// put uploads content as one version of a node and returns the version.
func (u *drillUser) put(node string, content []byte) (versionID, blobID string) {
	u.h.t.Helper()
	upload := u.id(u.call(http.MethodPost, "/api/v1/uploads", map[string]any{
		"node_id": node, "version_id": store.NewID(), "suite": suiteOf(u.mode),
		"frame_count": 1, "frame_size": 4096, "stored_size": len(content),
	}))
	status, out := u.do(http.MethodPut, "/api/v1/uploads/"+upload+"/frames/0", content, "X-Content-SHA256", b64(sha(content)))
	if status != http.StatusNoContent {
		u.h.t.Fatalf("frame: %d %s", status, out)
	}
	var v struct {
		ID     string `json:"id"`
		BlobID string `json:"blob_id"`
	}
	data := u.call(http.MethodPost, "/api/v1/uploads/"+upload+"/commit", map[string]any{
		"signature": opaque(u.mode, 9, 64), "manifest": b64([]byte(`{"manifest":true}`)),
	})
	if err := json.Unmarshal(data, &v); err != nil {
		u.h.t.Fatal(err)
	}
	return v.ID, v.BlobID
}

func sha(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

func mustJSON(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}

// drillState is what the drill wrote, to look for after the restore.
type drillState struct {
	folder, file, note, link, token string
	contents                        map[string][]byte // blob id to bytes
	noteMetadata                    []byte
}

func fillServer(t *testing.T, h *harness, mode string) drillState {
	t.Helper()
	h.setupMode(mode)
	root := h.drillUser("root", mode)

	invite := root.call(http.MethodPost, "/api/v1/admin/invites", map[string]any{})
	var created struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(invite, &created); err != nil {
		t.Fatal(err)
	}
	anonymous := &signedIn{h: h}
	anonymous.call(http.MethodPost, "/api/v1/auth/register", map[string]any{"invite_token": created.Token, "account": newAccount("bob", mode)})
	bob := h.drillUser("bob", mode)
	bob.root()

	s := drillState{contents: map[string][]byte{}, noteMetadata: []byte("sealed note metadata " + mode)}
	top := root.root()
	s.folder = root.node(top, "folder", "Projects", []byte("sealed folder"))
	s.file = root.node(s.folder, "file", "plan.txt", []byte("sealed file"))
	for _, content := range [][]byte{bytes.Repeat([]byte("first version "+mode+" "), 8), bytes.Repeat([]byte("second version, longer "+mode+" "), 9)} {
		_, blob := root.put(s.file, content)
		s.contents[blob] = content
	}
	s.note = root.node(top, "file", "note.md", s.noteMetadata)
	noteBody := bytes.Repeat([]byte("# A note\n\n- [ ] a task "+mode+"\n"), 4)
	_, blob := root.put(s.note, noteBody)
	s.contents[blob] = noteBody

	root.call(http.MethodPost, "/api/v1/grants", map[string]any{
		"node_id": s.folder, "grantee_id": bob.userID, "role": "viewer", "key_generation": 1,
		"sealed_key": opaque(mode, 3, 105), "signature": opaque(mode, 9, 64),
	})
	s.link = store.NewID()
	root.call(http.MethodPost, "/api/v1/links", map[string]any{
		"id": s.link, "node_id": s.file, "role": "view", "key_generation": 1,
		"sealed_key": opaque(mode, 4, 73), "owner_sealed_key": opaque(mode, 4, 73),
	})
	var token struct {
		Secret string `json:"secret"`
	}
	data := root.call(http.MethodPost, "/api/v1/me/tokens", map[string]any{"name": "phone", "current_auth_key": b64(auth.HashToken("root"))})
	if err := json.Unmarshal(data, &token); err != nil {
		t.Fatal(err)
	}
	s.token = token.Secret
	return s
}

func checkRestored(t *testing.T, h *harness, mode string, s drillState) {
	t.Helper()
	root := h.drillUser("root", mode)
	bob := h.drillUser("bob", mode)

	var health struct {
		Mode string `json:"mode"`
	}
	if err := json.Unmarshal(root.call(http.MethodGet, "/api/v1/health", nil), &health); err != nil || health.Mode != mode {
		t.Errorf("health = %+v, %v", health, err)
	}

	// Every version of the file, and the note, with their bytes.
	var page struct {
		Versions []struct {
			BlobID string `json:"blob_id"`
		} `json:"versions"`
	}
	if err := json.Unmarshal(root.call(http.MethodGet, "/api/v1/nodes/"+s.file+"/versions", nil), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Versions) != 2 {
		t.Errorf("versions after restore = %d, want 2", len(page.Versions))
	}
	for blob, want := range s.contents {
		if got := root.call(http.MethodGet, "/api/v1/blobs/"+blob, nil); !bytes.Equal(got, want) {
			t.Errorf("blob %s = %q, want %q", blob, got, want)
		}
	}
	var note struct {
		SealedMetadata string `json:"sealed_metadata"`
	}
	if err := json.Unmarshal(root.call(http.MethodGet, "/api/v1/nodes/"+s.note, nil), &note); err != nil || note.SealedMetadata != b64(s.noteMetadata) {
		t.Errorf("note = %+v, %v", note, err)
	}

	// The share, from the side of the person it was shared with.
	var shared struct {
		Items []struct {
			Node struct {
				ID string `json:"id"`
			} `json:"node"`
		} `json:"items"`
	}
	if err := json.Unmarshal(bob.call(http.MethodGet, "/api/v1/shared-with-me", nil), &shared); err != nil {
		t.Fatal(err)
	}
	if len(shared.Items) != 1 || shared.Items[0].Node.ID != s.folder {
		t.Errorf("shared with bob after restore = %+v", shared)
	}
	if status := bob.status(http.MethodGet, "/api/v1/nodes/"+s.file); status != http.StatusOK {
		t.Errorf("bob reads the shared file: %d", status)
	}

	// The public link, to anyone, and the device token.
	anonymous := &signedIn{h: h}
	if status := anonymous.status(http.MethodGet, "/api/v1/public/links/"+s.link); status != http.StatusOK {
		t.Errorf("public link after restore: %d", status)
	}
	if status, _ := anonymous.do(http.MethodGet, "/api/v1/me", nil, "Authorization", "Bearer "+s.token); status != http.StatusOK {
		t.Errorf("device token after restore: %d", status)
	}
}

func TestBackupAndRestoreDrill(t *testing.T) {
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			dir := t.TempDir()
			st, err := store.Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = st.Close() }()
			h := newHarness(t, st)
			state := fillServer(t, h, mode)

			// The backup runs while the server keeps writing.
			busy := h.drillUser("root", mode)
			parent := busy.root()
			stop := make(chan struct{})
			var wg sync.WaitGroup
			wg.Go(func() {
				for i := 0; ; i++ {
					select {
					case <-stop:
						return
					default:
						busy.node(parent, "folder", "busy"+string(rune('a'+i%26))+store.NewID(), []byte("x"))
					}
				}
			})
			backupDir := filepath.Join(t.TempDir(), "backup")
			err = runBackup(ctx, dir, backupDir, func() time.Time { return t0 })
			close(stop)
			wg.Wait()
			if err != nil {
				t.Fatalf("backup: %v", err)
			}

			restored := filepath.Join(t.TempDir(), "restored")
			if err := runRestore(ctx, backupDir, restored); err != nil {
				t.Fatalf("restore: %v", err)
			}
			// Never over something that exists: a second restore, or the live directory.
			if err := runRestore(ctx, backupDir, restored); err == nil {
				t.Error("restored over a restored directory")
			}
			if err := runRestore(ctx, backupDir, dir); err == nil {
				t.Error("restored over the live data directory")
			}
			h.close()

			// In mode none the stored files are the bytes the client sent; in
			// end-to-end mode they are whatever it sealed. Either way the restored
			// directory holds them as they were.
			for blob, want := range state.contents {
				got, err := os.ReadFile(filepath.Join(restored, "blobs", blob[:2], blob))
				if err != nil || !bytes.Equal(got, want) {
					t.Errorf("restored file %s = %q, %v", blob, got, err)
				}
			}

			st2, err := store.Open(restored)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = st2.Close() }()
			checkRestored(t, newHarness(t, st2), mode, state)
		})
	}
}

func TestRestoreRefuses(t *testing.T) {
	ctx := context.Background()
	if err := runRestore(ctx, t.TempDir(), filepath.Join(t.TempDir(), "data")); err == nil {
		t.Error("restored a directory that is not a finished backup")
	}

	// A backup of an empty server, to try the rest against.
	live := t.TempDir()
	st, err := store.Open(live)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	backupDir := filepath.Join(t.TempDir(), "backup")
	if err := runBackup(ctx, live, backupDir, time.Now); err != nil {
		t.Fatal(err)
	}

	full := t.TempDir()
	if err := os.WriteFile(filepath.Join(full, "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runRestore(ctx, backupDir, full); err == nil || !bytes.Contains([]byte(err.Error()), []byte("not empty")) {
		t.Errorf("restore over a directory with something in it: %v", err)
	}
	if err := runRestore(ctx, backupDir, filepath.Join(backupDir, "inside")); err == nil {
		t.Error("restored into the backup")
	}

	// A backup from a newer release is refused before anything is written.
	newer := filepath.Join(t.TempDir(), "newer")
	if err := runBackup(ctx, live, newer, time.Now); err != nil {
		t.Fatal(err)
	}
	setUserVersion(t, filepath.Join(newer, "yondrive.db"), store.LatestSchema()+1)
	dest := filepath.Join(t.TempDir(), "data")
	if err := runRestore(ctx, newer, dest); !errors.Is(err, store.ErrSchemaTooNew) {
		t.Errorf("restore of a newer backup: %v", err)
	}
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a refused restore left %s behind: %v", dest, err)
	}

	stderr := os.Stderr
	devnull, _ := os.Open(os.DevNull)
	defer func() { _ = devnull.Close() }()
	os.Stderr = devnull
	defer func() { os.Stderr = stderr }()
	if err := restore([]string{}); err == nil {
		t.Error("no backup named, and accepted")
	}
}

// setUserVersion stamps a database with a schema version, as a newer release would.
func setUserVersion(t *testing.T, path string, version int) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("PRAGMA user_version = " + strconv.Itoa(version)); err != nil {
		t.Fatal(err)
	}
}
