package store

import (
	"bytes"
	"database/sql"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Upgrade tests: a database made by every earlier release, holding what that
// release wrote, opened by this one. Each seed writes with the schema as its
// migration left it, through SQL of that time rather than through the store,
// whose queries are always the latest. A database created at schema 1 then
// grows the way a real one does: seed 1, migration 2, seed 2, and so on up to k,
// before this binary migrates it the rest of the way.

// Ids of what the seeds write. Every id is 32 hex characters, as the store's.
var (
	upRoot     = strings.Repeat("a1", 16)
	upBob      = strings.Repeat("b2", 16)
	upSSO      = strings.Repeat("c3", 16)
	upRootNode = strings.Repeat("d4", 16)
	upFolder   = strings.Repeat("d5", 16)
	upFile     = strings.Repeat("d6", 16)
	upNote     = strings.Repeat("d7", 16)
	upBobNode  = strings.Repeat("d8", 16)
	upBlob1    = strings.Repeat("e1", 16)
	upBlob2    = strings.Repeat("e2", 16)
	upThumb    = strings.Repeat("e3", 16)
	upIndex    = strings.Repeat("e4", 16)
	upVersion1 = strings.Repeat("f1", 16)
	upVersion2 = strings.Repeat("f2", 16)
	upUpload   = strings.Repeat("f3", 16)
	upGrant    = strings.Repeat("0a", 16)
	upLink     = strings.Repeat("0b", 16)
	upToken    = strings.Repeat("0c", 16)
	upInvite   = strings.Repeat("0d", 16)
)

const (
	upAt      = 1_700_000_000
	upFar     = 4_000_000_000
	upIssuer  = "https://id.example.com"
	upSubject = "sso-subject"
)

func blob(v byte, n int) []byte { return bytes.Repeat([]byte{v}, n) }

// seeds[i] writes what a server at schema i+1 would have written.
var seeds = []func(t *testing.T, db *sql.DB){
	// 1: setup, accounts, sessions, tokens, invites, resets, TOTP and the audit trail.
	func(t *testing.T, db *sql.DB) {
		exec(t, db, `INSERT INTO settings (key, value) VALUES
			('mode', 'e2e'), ('name', 'Home'), ('public_url', 'https://drive.example.com'),
			('default_quota_bytes', '1000000'), ('language', 'en'), ('time_zone', 'Europe/Madrid'),
			('open_signup', '0'), ('server_secret', ?)`, strings.Repeat("5", 64))
		for _, u := range []struct{ id, name, role string }{{upRoot, "root", "admin"}, {upBob, "bob", "user"}} {
			exec(t, db, `INSERT INTO users (id, username, email, role, quota_bytes, kdf, auth_key_hash,
				recovery_auth_key_hash, wrapped_master_key, wrapped_master_key_recovery, sealed_x25519,
				sealed_ed25519, public_key_x25519, public_key_ed25519, created_at)
				VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				u.id, u.name, u.name+"@example.com", u.role, []byte(`{"name":"argon2id"}`), hash(u.name),
				hash(u.name+"r"), blob(1, 72), blob(2, 72), blob(3, 72), blob(4, 72), blob(5, 32), blob(6, 32), upAt)
		}
		exec(t, db, `UPDATE users SET totp_secret = ?, totp_enabled_at = ?, totp_last_step = 7 WHERE id = ?`, blob(9, 20), upAt, upBob)
		exec(t, db, `INSERT INTO recovery_codes (user_id, hash) VALUES (?, ?)`, upBob, hash("code"))
		exec(t, db, `INSERT INTO sessions (hash, user_id, created_at, expires_at, absolute_at) VALUES (?, ?, ?, ?, ?)`, hash("session"), upRoot, upAt, upFar, upFar)
		exec(t, db, `INSERT INTO tokens (id, user_id, name, hash, created_at) VALUES (?, ?, 'phone', ?, ?)`, upToken, upRoot, hash("token"), upAt)
		exec(t, db, `INSERT INTO invites (id, token_hash, email, role, created_by, created_at, expires_at) VALUES (?, ?, 'carol@example.com', 'user', ?, ?, ?)`, upInvite, hash("invite"), upRoot, upAt, upFar)
		exec(t, db, `INSERT INTO password_resets (hash, user_id, expires_at) VALUES (?, ?, ?)`, hash("reset"), upBob, upFar)
		exec(t, db, `INSERT INTO audit (at, action, actor_id, remote) VALUES (?, 'setup_completed', ?, '127.0.0.1')`, upAt, upRoot)
	},
	// 2: a drive with two versions of a file, a thumbnail, an index segment, an
	// upload in progress and the journal.
	func(t *testing.T, db *sql.DB) {
		node := `INSERT INTO nodes (id, owner_id, parent_id, kind, suite, sealed_metadata, wrapped_key, name_tag, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'xchacha20poly1305-v1', ?, ?, ?, ?, ?)`
		exec(t, db, node, upRootNode, upRoot, nil, "folder", blob(1, 10), blob(7, 73), nil, upAt, upAt)
		exec(t, db, node, upBobNode, upBob, nil, "folder", blob(1, 10), blob(7, 73), nil, upAt, upAt)
		exec(t, db, node, upFolder, upRoot, upRootNode, "folder", blob(2, 40), blob(7, 73), hash("folder"), upAt, upAt)
		exec(t, db, node, upFile, upRoot, upFolder, "file", blob(3, 60), blob(7, 73), hash("file"), upAt, upAt)
		insertBlob := `INSERT INTO blobs (id, owner_id, node_id, kind, suite, size, ref_count, created_at) VALUES (?, ?, ?, ?, 'xchacha20poly1305-v1', ?, 0, ?)`
		exec(t, db, insertBlob, upBlob1, upRoot, upFile, "content", 1000, upAt)
		exec(t, db, insertBlob, upBlob2, upRoot, upFile, "content", 2000, upAt)
		exec(t, db, insertBlob, upThumb, upRoot, upFile, "thumb", 300, upAt)
		exec(t, db, insertBlob, upIndex, upRoot, nil, "index", 400, upAt)
		version := `INSERT INTO versions (id, node_id, blob_id, suite, author_id, content_version_id, content_author_id,
			stored_size, frame_count, frame_size, frame_hashes, signature, manifest, created_at)
			VALUES (?, ?, ?, 'xchacha20poly1305-v1', ?, ?, ?, ?, 1, 4096, ?, ?, ?, ?)`
		exec(t, db, version, upVersion1, upFile, upBlob1, upRoot, upVersion1, upRoot, 1000, hash("frames1"), blob(9, 64), []byte("m1"), upAt)
		exec(t, db, version, upVersion2, upFile, upBlob2, upRoot, upVersion2, upRoot, 2000, hash("frames2"), blob(9, 64), []byte("m2"), upAt+1)
		exec(t, db, `UPDATE nodes SET current_version = ? WHERE id = ?`, upVersion2, upFile)
		exec(t, db, `INSERT INTO uploads (id, user_id, owner_id, node_id, version_id, suite, frame_count, frame_size, stored_size, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, 'xchacha20poly1305-v1', 2, 4096, 5000, ?, ?)`, upUpload, upRoot, upRoot, upFile, NewID(), upAt, upAt)
		exec(t, db, `INSERT INTO upload_frames (upload_id, idx, sha256) VALUES (?, 0, ?)`, upUpload, hash("frame"))
		for _, n := range []string{upRootNode, upFolder, upFile} {
			exec(t, db, `INSERT INTO changes (owner_id, node_id, op, at) VALUES (?, ?, 'created', ?)`, upRoot, n, upAt)
		}
	},
	// 3: a share, a public link that has counted a download, and a rotated key.
	func(t *testing.T, db *sql.DB) {
		exec(t, db, `INSERT INTO grants (id, node_id, grantee_id, granter_id, role, key_generation, sealed_key, signature, created_at, updated_at)
			VALUES (?, ?, ?, ?, 'viewer', 1, ?, ?, ?, ?)`, upGrant, upFolder, upBob, upRoot, blob(3, 105), blob(9, 64), upAt, upAt)
		exec(t, db, `INSERT INTO links (id, node_id, owner_id, role, key_generation, sealed_key, owner_sealed_key, expires_at, download_limit, download_count, created_at)
			VALUES (?, ?, ?, 'view', 1, ?, ?, ?, 10, 1, ?)`, upLink, upFile, upRoot, blob(4, 73), blob(4, 73), upFar, upAt)
		exec(t, db, `INSERT INTO link_downloads (link_id, session_id, blob_id, created_at) VALUES (?, 'session', ?, ?)`, upLink, upBlob2, upAt)
		exec(t, db, `UPDATE nodes SET key_generation = 2 WHERE id = ?`, upFile)
		exec(t, db, `INSERT INTO node_key_history (node_id, generation, sealed_key, created_at) VALUES (?, 1, ?, ?)`, upFile, blob(5, 73), upAt)
		for _, u := range []string{upRoot, upBob} {
			exec(t, db, `INSERT INTO changes (user_id, node_id, op, at) VALUES (?, ?, 'shared', ?)`, u, upFolder, upAt)
		}
	},
	// 4: metadata is charged from here on: a new note, and a renamed file.
	func(t *testing.T, db *sql.DB) {
		exec(t, db, `INSERT INTO nodes (id, owner_id, parent_id, kind, suite, sealed_metadata, wrapped_key, name_tag, created_at, updated_at)
			VALUES (?, ?, ?, 'file', 'xchacha20poly1305-v1', ?, ?, ?, ?, ?)`, upNote, upRoot, upRootNode, blob(8, 90), blob(7, 73), hash("note"), upAt, upAt)
		exec(t, db, `UPDATE nodes SET sealed_metadata = ? WHERE id = ?`, blob(3, 70), upFile)
	},
	// 5: the journal trimmed past its first entry.
	func(t *testing.T, db *sql.DB) {
		exec(t, db, `DELETE FROM changes WHERE seq = 1`)
		exec(t, db, `UPDATE users SET journal_floor = 1 WHERE id = ?`, upRoot)
	},
	// 6: an account that signs in only through a provider.
	func(t *testing.T, db *sql.DB) {
		exec(t, db, `INSERT INTO users (id, username, role, kdf, unlock_auth_key_hash, oidc_issuer, oidc_subject, created_at)
			VALUES (?, 'sso', 'user', ?, ?, ?, ?, ?)`, upSSO, []byte(`{"name":"argon2id"}`), hash("unlock"), upIssuer, upSubject, upAt)
	},
	// 7: someone has the file open in an editor.
	func(t *testing.T, db *sql.DB) {
		exec(t, db, `INSERT INTO edit_status (node_id, user_id, started_at, expires_at) VALUES (?, ?, ?, ?)`, upFile, upBob, upAt, upFar)
	},
}

func exec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", strings.Join(strings.Fields(query), " "), err)
	}
}

func TestEveryMigrationHasASeed(t *testing.T) {
	if len(seeds) != LatestSchema() {
		t.Fatalf("%d seeds for %d migrations: add one for the new migration, writing what that release writes", len(seeds), LatestSchema())
	}
}

// databaseAt makes a database that grew to schema k with data written at each step.
func databaseAt(t *testing.T, dir string, k int) {
	t.Helper()
	db, err := sql.Open("sqlite", dsn(filepath.Join(dir, dbFile), "_pragma=journal_mode(WAL)"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	for v := 1; v <= k; v++ {
		if err := migrateTo(ctx, db, v); err != nil {
			t.Fatalf("migrate to %d: %v", v, err)
		}
		seeds[v-1](t, db)
	}
}

func TestUpgradeFromEverySchema(t *testing.T) {
	latest := LatestSchema()
	for k := 1; k <= latest; k++ {
		t.Run("from "+strconv.Itoa(k), func(t *testing.T) {
			dir := t.TempDir()
			databaseAt(t, dir, k)
			st, err := Open(dir)
			if err != nil {
				t.Fatalf("open a database at schema %d: %v", k, err)
			}
			defer func() { _ = st.Close() }()
			checkInvariants(t, st)
			checkUpgradedData(t, st, k)
			checkWritable(t, st, k)
			checkInvariants(t, st)
		})
	}
}

// checkInvariants holds of any database, however it got here.
func checkInvariants(t *testing.T, st *Store) {
	t.Helper()
	var version int
	var check string
	if err := st.read.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != LatestSchema() {
		t.Errorf("user_version = %d, %v", version, err)
	}
	if err := st.read.QueryRow("PRAGMA integrity_check").Scan(&check); err != nil || check != "ok" {
		t.Errorf("integrity_check = %q, %v", check, err)
	}
	rows, err := st.read.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	if rows.Next() {
		t.Error("a row breaks a foreign key")
	}
	_ = rows.Close()

	// The counters agree with what they count.
	type mismatch struct {
		id                       string
		used, wantUsed, reserved int64
		wantReserved             int64
	}
	var bad []mismatch
	rows, err = st.read.Query(`SELECT id, used_bytes,
		coalesce((SELECT sum(size) FROM blobs WHERE owner_id = users.id), 0)
		  + coalesce((SELECT sum(length(sealed_metadata)) FROM nodes WHERE owner_id = users.id), 0),
		reserved_bytes, coalesce((SELECT sum(stored_size) FROM uploads WHERE owner_id = users.id), 0)
		FROM users`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var m mismatch
		if err := rows.Scan(&m.id, &m.used, &m.wantUsed, &m.reserved, &m.wantReserved); err != nil {
			t.Fatal(err)
		}
		if m.used != m.wantUsed || m.reserved != m.wantReserved {
			bad = append(bad, m)
		}
	}
	_ = rows.Close()
	if len(bad) > 0 {
		t.Errorf("quota counters disagree: %+v", bad)
	}
	var refs int
	if err := st.read.QueryRow(`SELECT count(*) FROM blobs WHERE kind = 'content'
		AND ref_count <> (SELECT count(*) FROM versions WHERE blob_id = blobs.id)`).Scan(&refs); err != nil || refs != 0 {
		t.Errorf("%d content blobs with a wrong ref_count, %v", refs, err)
	}
}

// checkUpgradedData finds what each seed up to k wrote, through the store.
func checkUpgradedData(t *testing.T, st *Store, k int) {
	t.Helper()
	settings, err := st.Settings(ctx)
	if err != nil || settings.Mode != "e2e" || settings.Name != "Home" || settings.DefaultQuotaBytes != 1_000_000 {
		t.Errorf("settings = %+v, %v", settings, err)
	}
	root, err := st.UserByUsername(ctx, "root")
	if err != nil || root.Role != "admin" || !bytes.Equal(root.AuthKeyHash, hash("root")) || !bytes.Equal(root.WrappedMasterKey, blob(1, 72)) {
		t.Errorf("root = %+v, %v", root, err)
	}
	if bob, err := st.UserByID(ctx, upBob); err != nil || !bob.TOTPEnabled {
		t.Errorf("bob = %+v, %v", bob, err)
	}
	if _, err := st.SessionByHash(ctx, hash("session")); err != nil {
		t.Errorf("session: %v", err)
	}
	if tok, err := st.TokenByHash(ctx, hash("token")); err != nil || tok.UserID != upRoot {
		t.Errorf("token = %+v, %v", tok, err)
	}
	if inv, err := st.InviteByHash(ctx, hash("invite")); err != nil || inv.Email != "carol@example.com" {
		t.Errorf("invite = %+v, %v", inv, err)
	}
	if n, err := st.CountRecoveryCodes(ctx, upBob); err != nil || n != 1 {
		t.Errorf("recovery codes = %d, %v", n, err)
	}
	if audit, err := st.ListAudit(ctx, 10); err != nil || len(audit) != 1 {
		t.Errorf("audit = %+v, %v", audit, err)
	}
	if k < 2 {
		return
	}

	file, err := st.NodeByID(ctx, upFile)
	if err != nil || file.CurrentVersion != upVersion2 || file.ParentID != upFolder {
		t.Errorf("file = %+v, %v", file, err)
	}
	versions, err := st.ListVersions(ctx, upFile, 0, 10)
	if err != nil || len(versions) != 2 {
		t.Fatalf("versions = %+v, %v", versions, err)
	}
	for _, v := range versions {
		if v.KeyGeneration != 1 {
			t.Errorf("version %s generation = %d, want 1 (they predate rotation)", v.ID, v.KeyGeneration)
		}
	}
	if up, err := st.UploadByID(ctx, upUpload); err != nil || up.StoredSize != 5000 {
		t.Errorf("upload = %+v, %v", up, err)
	}
	if index, err := st.ListIndexBlobs(ctx, upRoot, "", 10); err != nil || len(index) != 1 {
		t.Errorf("index = %+v, %v", index, err)
	}
	// The journal's rows from before sharing became root's own.
	changes, err := st.ListChanges(ctx, upRoot, 0, 100)
	if err != nil || len(changes) == 0 {
		t.Errorf("root's journal = %+v, %v", changes, err)
	}
	if k < 3 {
		return
	}

	if file.KeyGeneration != 2 {
		t.Errorf("file generation = %d", file.KeyGeneration)
	}
	grants, err := st.ListGrantsForGrantee(ctx, upBob, "", 10)
	if err != nil || len(grants) != 1 || grants[0].NodeID != upFolder {
		t.Errorf("bob's grants = %+v, %v", grants, err)
	}
	if link, err := st.LinkByID(ctx, upLink); err != nil || link.DownloadCount != 1 || link.DownloadLimit != 10 {
		t.Errorf("link = %+v, %v", link, err)
	}
	if bobChanges, err := st.ListChanges(ctx, upBob, 0, 100); err != nil || len(bobChanges) != 1 {
		t.Errorf("bob's journal = %+v, %v", bobChanges, err)
	}
	if k < 4 {
		return
	}

	if note, err := st.NodeByID(ctx, upNote); err != nil || !bytes.Equal(note.SealedMetadata, blob(8, 90)) {
		t.Errorf("note = %+v, %v", note, err)
	}
	if k < 5 {
		return
	}

	if floor, err := st.JournalFloor(ctx, upRoot); err != nil || floor != 1 {
		t.Errorf("journal floor = %d, %v", floor, err)
	}
	if k < 6 {
		return
	}

	if sso, err := st.UserByIdentity(ctx, upIssuer, upSubject); err != nil || sso.ID != upSSO || len(sso.AuthKeyHash) != 0 || !bytes.Equal(sso.UnlockAuthKeyHash, hash("unlock")) {
		t.Errorf("sso = %+v, %v", sso, err)
	}
	if k < 7 {
		return
	}

	if editors, err := st.Editors(ctx, upFile, t0); err != nil || len(editors) != 1 || editors[0].UserID != upBob {
		t.Errorf("editors = %+v, %v", editors, err)
	}
}

// checkWritable writes through the store what the latest release writes, on top
// of the upgraded data.
func checkWritable(t *testing.T, st *Store, k int) {
	t.Helper()
	carol := user("carol")
	if err := st.CreateUser(ctx, carol, "", t0); err != nil {
		t.Fatalf("a new user after the upgrade: %v", err)
	}
	if k < 2 {
		return
	}
	n := Node{ID: NewID(), OwnerID: upRoot, ParentID: upFolder, Kind: "folder", Suite: "xchacha20poly1305-v1",
		SealedMetadata: blob(1, 33), WrappedKey: blob(7, 73), NameTag: hash("new"), CreatedAt: t0, UpdatedAt: t0}
	gen := int64(1)
	if _, err := st.CreateNode(ctx, n, &gen); err != nil {
		t.Errorf("a new node after the upgrade: %v", err)
	}
	if _, err := st.TrashNode(ctx, upFile, t0); err != nil {
		t.Errorf("trash after the upgrade: %v", err)
	}
	if _, err := st.DeleteUser(ctx, upBob); err != nil {
		t.Errorf("delete a user after the upgrade: %v", err)
	}
}

func TestADatabaseFromANewerReleaseIsRefused(t *testing.T) {
	dir := t.TempDir()
	databaseAt(t, dir, LatestSchema())
	db, err := sql.Open("sqlite", dsn(filepath.Join(dir, dbFile)))
	if err != nil {
		t.Fatal(err)
	}
	exec(t, db, "PRAGMA user_version = "+strconv.Itoa(LatestSchema()+1))
	_ = db.Close()

	if _, err := Open(dir); !errors.Is(err, ErrSchemaTooNew) {
		t.Fatalf("Open: %v, want ErrSchemaTooNew", err)
	}
	if _, err := OpenLive(dir); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("OpenLive: %v, want ErrSchemaTooNew", err)
	}
	if have, want, err := SchemaVersion(dir); err != nil || have != want+1 {
		t.Errorf("SchemaVersion = %d, %d, %v", have, want, err)
	}
	// Nothing was written: the data is as the newer release left it.
	if err := RestoreDatabase(ctx, dir, t.TempDir()); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("RestoreDatabase: %v, want ErrSchemaTooNew", err)
	}
	db, err = sql.Open("sqlite", dsn(filepath.Join(dir, dbFile)))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var users int
	if err := db.QueryRow("SELECT count(*) FROM users").Scan(&users); err != nil || users != 3 {
		t.Errorf("users = %d, %v", users, err)
	}
}

func TestRestoreDatabaseCopiesAndChecks(t *testing.T) {
	src := t.TempDir()
	databaseAt(t, src, 3)
	dst := t.TempDir()
	if err := RestoreDatabase(ctx, src, dst); err != nil {
		t.Fatal(err)
	}
	// An older backup restores as it is, and the server migrates it on start.
	if have, _, err := SchemaVersion(dst); err != nil || have != 3 {
		t.Errorf("restored schema = %d, %v", have, err)
	}
	st, err := Open(dst)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	checkInvariants(t, st)
	checkUpgradedData(t, st, 3)
}
