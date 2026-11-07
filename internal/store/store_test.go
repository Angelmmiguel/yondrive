package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var (
	ctx = context.Background()
	t0  = time.Unix(1_800_000_000, 0).UTC()
)

func open(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func hash(s string) []byte { return bytes.Repeat([]byte(s), 32)[:32] }

func user(name string) User {
	return User{
		ID:         NewID(),
		Username:   name,
		Role:       "user",
		QuotaBytes: 100,
		CreatedAt:  t0,
		Credentials: Credentials{
			AuthKeyHash: hash("a"),
			KDF:         []byte(`{"salt":"x"}`),
		},
	}
}

func addUser(t *testing.T, st *Store, name string) User {
	t.Helper()
	u := user(name)
	if err := st.CreateUser(ctx, u, "", t0); err != nil {
		t.Fatal(err)
	}
	return u
}

func addSession(t *testing.T, st *Store, userID, name string) []byte {
	t.Helper()
	h := hash(name)
	err := st.CreateSession(ctx, Session{Hash: h, UserID: userID, CreatedAt: t0, ExpiresAt: t0.Add(time.Hour), AbsoluteAt: t0.Add(2 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func addToken(t *testing.T, st *Store, userID, name string) Token {
	t.Helper()
	tok := Token{ID: NewID(), UserID: userID, Name: name, Hash: hash(name), CreatedAt: t0}
	if err := st.CreateToken(ctx, tok); err != nil {
		t.Fatal(err)
	}
	return tok
}

func settings() Settings {
	return Settings{Mode: "e2e", Name: "Home", PublicURL: "http://x", DefaultQuotaBytes: 5, Language: "en", TimeZone: "UTC", PurgeGraceDays: DefaultPurgeGraceDays, TrashRetentionDays: DefaultTrashRetentionDays, AuditRetentionDays: DefaultAuditRetentionDays, JournalRetentionDays: DefaultJournalRetentionDays, LocalAccounts: true, OIDC: DefaultOIDCSettings()}
}

func TestOpenAppliesPragmasAndPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	var mode string
	var fk, busy int
	if err := st.write.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Errorf("journal_mode = %q, %v", mode, err)
	}
	if err := st.read.QueryRow("PRAGMA foreign_keys").Scan(&fk); err != nil || fk != 1 {
		t.Errorf("foreign_keys = %d, %v", fk, err)
	}
	if err := st.read.QueryRow("PRAGMA busy_timeout").Scan(&busy); err != nil || busy != busyTimeoutMillis {
		t.Errorf("busy_timeout = %d, %v", busy, err)
	}
	var secureDelete int
	if err := st.write.QueryRow("PRAGMA secure_delete").Scan(&secureDelete); err != nil || secureDelete != 1 {
		t.Errorf("secure_delete = %d, %v", secureDelete, err)
	}
	if st.write.Stats().MaxOpenConnections != 1 {
		t.Error("the writer pool holds more than one connection")
	}
	if _, err := st.read.Exec("DELETE FROM users"); err == nil {
		t.Error("the read pool accepted a write")
	}
	for name, want := range map[string]os.FileMode{dbFile: 0o600, lockFile: 0o600, ".": 0o700} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode = %o, want %o", name, got, want)
		}
	}
}

func TestLockRefusesASecondProcess(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Open: %v, want ErrLocked", err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	again, err := Open(dir)
	if err != nil {
		t.Fatalf("Open after Close: %v", err)
	}
	_ = again.Close()
}

func TestMigrationsAreVersionedAndIdempotent(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var version int
	entries, _ := migrations.ReadDir("migrations")
	if err := st.read.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != len(entries) {
		t.Fatalf("user_version = %d, %v", version, err)
	}
	u := addUser(t, st, "alice")
	_ = st.Close()

	st, err = Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if _, err := st.UserByID(ctx, u.ID); err != nil {
		t.Errorf("data lost across reopen: %v", err)
	}
	if _, err := st.write.Exec("PRAGMA user_version = 99"); err != nil {
		t.Fatal(err)
	}
	_ = st.Close()

	if _, err := Open(dir); !errors.Is(err, ErrSchemaTooNew) {
		t.Fatalf("Open newer database: %v, want ErrSchemaTooNew", err)
	}
	// The failed Open released the lock.
	if _, err := acquireLock(filepath.Join(dir, lockFile)); err != nil {
		t.Errorf("lock not released after failed Open: %v", err)
	}
}

func TestCompleteSetupIsAtomicAndOnce(t *testing.T) {
	st := open(t)
	if _, err := st.Settings(ctx); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("Settings before setup: %v", err)
	}

	bad := user("root")
	bad.Role = "nonsense" // violates the CHECK constraint, after the settings went in
	if err := st.CompleteSetup(ctx, settings(), bad); err == nil {
		t.Fatal("setup with a bad user succeeded")
	}
	if _, err := st.Settings(ctx); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("a failed setup left settings behind: %v", err)
	}

	admin := user("root")
	admin.Role = "admin"
	if err := st.CompleteSetup(ctx, settings(), admin); err != nil {
		t.Fatal(err)
	}
	got, err := st.Settings(ctx)
	if err != nil || got != settings() {
		t.Fatalf("Settings = %+v, %v", got, err)
	}
	if err := st.CompleteSetup(ctx, settings(), user("other")); !errors.Is(err, ErrAlreadyConfigured) {
		t.Fatalf("second setup: %v", err)
	}
}

func TestModeIsImmutable(t *testing.T) {
	st := open(t)
	if err := st.CompleteSetup(ctx, settings(), user("root")); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		"UPDATE settings SET value = 'none' WHERE key = 'mode'",
		"DELETE FROM settings WHERE key = 'mode'",
		"INSERT OR REPLACE INTO settings (key, value) VALUES ('mode', 'none')",
		"UPDATE settings SET key = 'mode' WHERE key = 'name'",
	} {
		if _, err := st.write.Exec(q); err == nil {
			t.Errorf("%s: accepted", q)
		}
	}
	if got, err := st.Settings(ctx); err != nil || got.Mode != "e2e" {
		t.Errorf("mode = %q, %v", got.Mode, err)
	}
}

func TestUpdateSettings(t *testing.T) {
	st := open(t)
	if err := st.CompleteSetup(ctx, settings(), user("root")); err != nil {
		t.Fatal(err)
	}
	name, quota, open := "Office", int64(9), true
	got, err := st.UpdateSettings(ctx, SettingsPatch{Name: &name, DefaultQuotaBytes: &quota, OpenSignup: &open})
	if err != nil {
		t.Fatal(err)
	}
	want := settings()
	want.Name, want.DefaultQuotaBytes, want.OpenSignup = name, quota, open
	if got != want {
		t.Errorf("settings = %+v, want %+v", got, want)
	}
	lang, tz, url := "es", "Europe/Madrid", "https://y"
	got, err = st.UpdateSettings(ctx, SettingsPatch{Language: &lang, TimeZone: &tz, PublicURL: &url})
	if err != nil || got.Language != lang || got.TimeZone != tz || got.PublicURL != url {
		t.Errorf("settings = %+v, %v", got, err)
	}
}

func TestServerSecretIsStableAndHidden(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.ServerSecret(ctx)
	if err != nil || len(first) != serverSecretLen {
		t.Fatalf("secret = %x, %v", first, err)
	}
	_ = st.Close()
	st, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	second, err := st.ServerSecret(ctx)
	if err != nil || !bytes.Equal(first, second) {
		t.Errorf("secret changed across reopen: %x, %x, %v", first, second, err)
	}
	// A secret alone does not make the server configured.
	if _, err := st.Settings(ctx); !errors.Is(err, ErrNotConfigured) {
		t.Errorf("Settings: %v", err)
	}
}

func TestUserRoundTrip(t *testing.T) {
	st := open(t)
	u := user("alice")
	u.Email = "Alice@Example.com"
	u.RecoveryAuthKeyHash = hash("r")
	u.WrappedMasterKey = []byte("wmk")
	u.WrappedMasterKeyRecovery = []byte("wmr")
	u.SealedX25519 = []byte("sx")
	u.SealedEd25519 = []byte("se")
	u.PublicKeyX25519 = hash("x")
	u.PublicKeyEd25519 = hash("e")
	if err := st.CreateUser(ctx, u, "", t0); err != nil {
		t.Fatal(err)
	}
	for _, get := range []func() (User, error){
		func() (User, error) { return st.UserByID(ctx, u.ID) },
		func() (User, error) { return st.UserByUsername(ctx, "alice") },
	} {
		got, err := get()
		if err != nil {
			t.Fatal(err)
		}
		if got.Email != u.Email || got.Role != "user" || got.QuotaBytes != 100 || !got.CreatedAt.Equal(t0) ||
			!bytes.Equal(got.AuthKeyHash, u.AuthKeyHash) || !bytes.Equal(got.RecoveryAuthKeyHash, u.RecoveryAuthKeyHash) ||
			!bytes.Equal(got.KDF, u.KDF) || !bytes.Equal(got.WrappedMasterKey, u.WrappedMasterKey) ||
			!bytes.Equal(got.WrappedMasterKeyRecovery, u.WrappedMasterKeyRecovery) ||
			!bytes.Equal(got.SealedX25519, u.SealedX25519) || !bytes.Equal(got.SealedEd25519, u.SealedEd25519) ||
			!bytes.Equal(got.PublicKeyX25519, u.PublicKeyX25519) || !bytes.Equal(got.PublicKeyEd25519, u.PublicKeyEd25519) ||
			got.Disabled || got.TOTPEnabled {
			t.Errorf("user = %+v", got)
		}
	}
	if _, err := st.UserByID(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	if _, err := st.UserByUsername(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown username: %v", err)
	}

	dup := user("alice")
	if err := st.CreateUser(ctx, dup, "", t0); !errors.Is(err, ErrUsernameTaken) {
		t.Errorf("duplicate username: %v", err)
	}
	dup = user("bob")
	dup.Email = "ALICE@example.com"
	if err := st.CreateUser(ctx, dup, "", t0); !errors.Is(err, ErrEmailTaken) {
		t.Errorf("duplicate email: %v", err)
	}
}

func TestListUsersAndQuota(t *testing.T) {
	st := open(t)
	b := addUser(t, st, "bob")
	addUser(t, st, "alice")
	users, err := st.ListUsers(ctx)
	if err != nil || len(users) != 2 || users[0].Username != "alice" {
		t.Fatalf("users = %+v, %v", users, err)
	}
	if err := st.SetQuota(ctx, b.ID, 7); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.UserByID(ctx, b.ID); got.QuotaBytes != 7 {
		t.Errorf("quota = %d", got.QuotaBytes)
	}
	if err := st.SetQuota(ctx, "nope", 7); !errors.Is(err, ErrNotFound) {
		t.Errorf("SetQuota unknown: %v", err)
	}
}

func TestDisableAndEnableUser(t *testing.T) {
	st := open(t)
	u, other := addUser(t, st, "alice"), addUser(t, st, "bob")
	h := addSession(t, st, u.ID, "s")
	kept := addSession(t, st, other.ID, "o")
	addToken(t, st, u.ID, "t")

	revoked, err := st.DisableUser(ctx, u.ID, t0)
	if err != nil || len(revoked) != 1 || !bytes.Equal(revoked[0], h) {
		t.Fatalf("revoked = %x, %v", revoked, err)
	}
	if got, _ := st.UserByID(ctx, u.ID); !got.Disabled {
		t.Error("not disabled")
	}
	if tokens, _ := st.ListTokens(ctx, u.ID); len(tokens) != 0 {
		t.Errorf("tokens survive: %v", tokens)
	}
	if _, err := st.SessionByHash(ctx, kept); err != nil {
		t.Errorf("another user's session ended: %v", err)
	}
	if err := st.EnableUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.UserByID(ctx, u.ID); got.Disabled {
		t.Error("still disabled")
	}
	if _, err := st.DisableUser(ctx, "nope", t0); !errors.Is(err, ErrNotFound) {
		t.Errorf("DisableUser unknown: %v", err)
	}
	if err := st.EnableUser(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("EnableUser unknown: %v", err)
	}
}

func TestDeleteUserCascades(t *testing.T) {
	st := open(t)
	u, admin := addUser(t, st, "alice"), addUser(t, st, "root")
	h := addSession(t, st, u.ID, "s")
	addToken(t, st, u.ID, "t")
	if err := st.EnableTOTP(ctx, u.ID, 1, 1, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("EnableTOTP without a secret: %v", err)
	}
	if err := st.SetPendingTOTP(ctx, u.ID, []byte("s")); err != nil {
		t.Fatal(err)
	}
	if err := st.EnableTOTP(ctx, u.ID, 1, 1, [][]byte{hash("c")}); err != nil {
		t.Fatal(err)
	}
	if err := st.CreatePasswordReset(ctx, hash("p"), u.ID, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	inv := Invite{ID: NewID(), TokenHash: hash("i"), Role: "user", CreatedBy: u.ID, CreatedAt: t0, ExpiresAt: t0.Add(time.Hour)}
	if err := st.CreateInvite(ctx, inv); err != nil {
		t.Fatal(err)
	}

	revoked, err := st.DeleteUser(ctx, u.ID)
	if err != nil || len(revoked) != 1 || !bytes.Equal(revoked[0], h) {
		t.Fatalf("revoked = %x, %v", revoked, err)
	}
	if _, err := st.UserByID(ctx, u.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("user survives: %v", err)
	}
	for _, table := range []string{"sessions", "tokens", "recovery_codes", "password_resets"} {
		var n int
		if err := st.read.QueryRow("SELECT count(*) FROM " + table).Scan(&n); err != nil || n != 0 {
			t.Errorf("%s holds %d rows, %v", table, n, err)
		}
	}
	got, err := st.InviteByHash(ctx, hash("i"))
	if err != nil || got.CreatedBy != "" {
		t.Errorf("invite = %+v, %v", got, err)
	}
	if _, err := st.DeleteUser(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteUser unknown: %v", err)
	}
	if _, err := st.UserByID(ctx, admin.ID); err != nil {
		t.Errorf("other user gone: %v", err)
	}
}

func TestUpdateCredentials(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	keep := addSession(t, st, u.ID, "k")
	gone := addSession(t, st, u.ID, "g")
	keepToken := addToken(t, st, u.ID, "kt")
	addToken(t, st, u.ID, "gt")

	revoked, err := st.UpdateCredentials(ctx, u.ID, CredentialUpdate{AuthKeyHash: hash("n"), WrappedMasterKey: []byte("w2")}, keep, keepToken.ID)
	if err != nil || len(revoked) != 1 || !bytes.Equal(revoked[0], gone) {
		t.Fatalf("revoked = %x, %v", revoked, err)
	}
	got, _ := st.UserByID(ctx, u.ID)
	if !bytes.Equal(got.AuthKeyHash, hash("n")) || string(got.WrappedMasterKey) != "w2" || !bytes.Equal(got.KDF, u.KDF) {
		t.Errorf("user = %+v", got)
	}
	if _, err := st.SessionByHash(ctx, keep); err != nil {
		t.Errorf("kept session gone: %v", err)
	}
	if tokens, _ := st.ListTokens(ctx, u.ID); len(tokens) != 1 || tokens[0].ID != keepToken.ID {
		t.Errorf("tokens = %+v", tokens)
	}
	if _, err := st.UpdateCredentials(ctx, "nope", CredentialUpdate{KDF: []byte("x")}, nil, ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown user: %v", err)
	}
}

func TestUpdateCredentialsIsAtomic(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	h := addSession(t, st, u.ID, "s")
	if _, err := st.write.Exec(`CREATE TRIGGER fail BEFORE DELETE ON tokens BEGIN SELECT RAISE(ABORT, 'boom'); END`); err != nil {
		t.Fatal(err)
	}
	addToken(t, st, u.ID, "t")
	if _, err := st.UpdateCredentials(ctx, u.ID, CredentialUpdate{AuthKeyHash: hash("n")}, nil, ""); err == nil {
		t.Fatal("update succeeded past the failing trigger")
	}
	got, _ := st.UserByID(ctx, u.ID)
	if !bytes.Equal(got.AuthKeyHash, u.AuthKeyHash) {
		t.Error("credentials changed although revocation failed")
	}
	if _, err := st.SessionByHash(ctx, h); err != nil {
		t.Errorf("session gone although the update rolled back: %v", err)
	}
}

func TestSessions(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	h := addSession(t, st, u.ID, "s")
	got, err := st.SessionByHash(ctx, h)
	if err != nil || got.UserID != u.ID || !got.CreatedAt.Equal(t0) || !got.ExpiresAt.Equal(t0.Add(time.Hour)) || !got.AbsoluteAt.Equal(t0.Add(2*time.Hour)) {
		t.Fatalf("session = %+v, %v", got, err)
	}
	if err := st.TouchSession(ctx, h, t0.Add(90*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.SessionByHash(ctx, h); !got.ExpiresAt.Equal(t0.Add(90 * time.Minute)) {
		t.Errorf("expires = %v", got.ExpiresAt)
	}

	if hashes, err := st.DeleteExpiredSessions(ctx, t0.Add(time.Hour)); err != nil || len(hashes) != 0 {
		t.Errorf("purged a live session: %x, %v", hashes, err)
	}
	if hashes, err := st.DeleteExpiredSessions(ctx, t0.Add(90*time.Minute)); err != nil || len(hashes) != 1 {
		t.Errorf("did not purge: %x, %v", hashes, err)
	}
	if _, err := st.SessionByHash(ctx, h); !errors.Is(err, ErrNotFound) {
		t.Errorf("after purge: %v", err)
	}

	h = addSession(t, st, u.ID, "z")
	if err := st.DeleteSession(ctx, h); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SessionByHash(ctx, h); !errors.Is(err, ErrNotFound) {
		t.Errorf("after delete: %v", err)
	}
}

func TestTokens(t *testing.T) {
	st := open(t)
	u, other := addUser(t, st, "alice"), addUser(t, st, "bob")
	tok := addToken(t, st, u.ID, "phone")
	got, err := st.TokenByHash(ctx, tok.Hash)
	if err != nil || got.ID != tok.ID || got.Name != "phone" || got.UserID != u.ID || !got.LastUsedAt.IsZero() {
		t.Fatalf("token = %+v, %v", got, err)
	}
	if _, err := st.TokenByHash(ctx, hash("z")); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}
	if err := st.TouchToken(ctx, tok.ID, t0.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	list, err := st.ListTokens(ctx, u.ID)
	if err != nil || len(list) != 1 || !list[0].LastUsedAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if err := st.DeleteToken(ctx, other.ID, tok.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("deleted another user's token: %v", err)
	}
	if err := st.DeleteToken(ctx, u.ID, tok.ID); err != nil {
		t.Fatal(err)
	}
}

func TestInvites(t *testing.T) {
	st := open(t)
	admin := addUser(t, st, "root")
	quota := int64(42)
	inv := Invite{ID: NewID(), TokenHash: hash("i"), Email: "a@b.c", Role: "admin", QuotaBytes: &quota, CreatedBy: admin.ID, CreatedAt: t0, ExpiresAt: t0.Add(time.Hour)}
	if err := st.CreateInvite(ctx, inv); err != nil {
		t.Fatal(err)
	}
	got, err := st.InviteByHash(ctx, hash("i"))
	if err != nil || got.Email != "a@b.c" || got.Role != "admin" || *got.QuotaBytes != 42 || got.CreatedBy != admin.ID || got.Used || !got.ExpiresAt.Equal(inv.ExpiresAt) {
		t.Fatalf("invite = %+v, %v", got, err)
	}
	if _, err := st.InviteByHash(ctx, hash("z")); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown: %v", err)
	}

	if err := st.CreateUser(ctx, user("late"), inv.ID, t0.Add(time.Hour)); !errors.Is(err, ErrInviteInvalid) {
		t.Errorf("expired invite: %v", err)
	}
	if _, err := st.UserByUsername(ctx, "late"); !errors.Is(err, ErrNotFound) {
		t.Error("a failed invite left the user behind")
	}
	if err := st.CreateUser(ctx, user(admin.Username), inv.ID, t0); !errors.Is(err, ErrUsernameTaken) {
		t.Errorf("taken username: %v", err)
	}
	if got, _ := st.InviteByHash(ctx, hash("i")); got.Used {
		t.Error("a failed registration burnt the invite")
	}
	if err := st.CreateUser(ctx, user("alice"), inv.ID, t0); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.InviteByHash(ctx, hash("i")); !got.Used {
		t.Error("invite not marked used")
	}
	if err := st.CreateUser(ctx, user("bob"), inv.ID, t0); !errors.Is(err, ErrInviteInvalid) {
		t.Errorf("reused invite: %v", err)
	}

	list, err := st.ListInvites(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list = %+v, %v", list, err)
	}
	if err := st.DeleteInvite(ctx, inv.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteInvite(ctx, inv.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
}

func TestPasswordResets(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	addSession(t, st, u.ID, "s")
	addToken(t, st, u.ID, "t")
	expiry := t0.Add(time.Hour)
	if err := st.CreatePasswordReset(ctx, hash("1"), u.ID, expiry); err != nil {
		t.Fatal(err)
	}
	if err := st.CreatePasswordReset(ctx, hash("2"), u.ID, expiry); err != nil {
		t.Fatal(err)
	}
	up := CredentialUpdate{AuthKeyHash: hash("n")}
	if _, _, err := st.ConsumePasswordReset(ctx, hash("1"), up, t0); !errors.Is(err, ErrResetInvalid) {
		t.Errorf("replaced reset: %v", err)
	}
	if _, _, err := st.ConsumePasswordReset(ctx, hash("2"), up, expiry); !errors.Is(err, ErrResetInvalid) {
		t.Errorf("expired reset: %v", err)
	}
	if got, _ := st.UserByID(ctx, u.ID); !bytes.Equal(got.AuthKeyHash, u.AuthKeyHash) {
		t.Error("an invalid reset changed the credentials")
	}
	if err := st.CreatePasswordReset(ctx, hash("3"), u.ID, expiry); err != nil {
		t.Fatal(err)
	}
	id, revoked, err := st.ConsumePasswordReset(ctx, hash("3"), up, t0)
	if err != nil || id != u.ID || len(revoked) != 1 {
		t.Fatalf("consume = %q, %x, %v", id, revoked, err)
	}
	if got, _ := st.UserByID(ctx, u.ID); !bytes.Equal(got.AuthKeyHash, hash("n")) {
		t.Error("credentials not replaced")
	}
	if tokens, _ := st.ListTokens(ctx, u.ID); len(tokens) != 0 {
		t.Error("tokens survive a reset")
	}
	if _, _, err := st.ConsumePasswordReset(ctx, hash("3"), up, t0); !errors.Is(err, ErrResetInvalid) {
		t.Errorf("reused reset: %v", err)
	}
}

func TestTOTP(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	if err := st.SetPendingTOTP(ctx, u.ID, []byte("s1")); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.UserByID(ctx, u.ID); got.TOTPEnabled || string(got.TOTPSecret) != "s1" {
		t.Errorf("pending = %+v", got)
	}
	if err := st.EnableTOTP(ctx, u.ID, 10, t0.Unix(), [][]byte{hash("a"), hash("b")}); err != nil {
		t.Fatal(err)
	}
	got, _ := st.UserByID(ctx, u.ID)
	if !got.TOTPEnabled || got.TOTPLastStep != 10 {
		t.Errorf("enabled = %+v", got)
	}
	if err := st.SetPendingTOTP(ctx, u.ID, []byte("s2")); !errors.Is(err, ErrNotFound) {
		t.Errorf("replaced a secret in force: %v", err)
	}
	if err := st.EnableTOTP(ctx, u.ID, 11, t0.Unix(), nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("enabled twice: %v", err)
	}

	for step, want := range map[int64]bool{10: false, 9: false} {
		if ok, err := st.ConsumeTOTPStep(ctx, u.ID, step); err != nil || ok != want {
			t.Errorf("step %d = %v, %v", step, ok, err)
		}
	}
	if ok, err := st.ConsumeTOTPStep(ctx, u.ID, 11); err != nil || !ok {
		t.Errorf("step 11 = %v, %v", ok, err)
	}

	if n, err := st.CountRecoveryCodes(ctx, u.ID); err != nil || n != 2 {
		t.Errorf("codes = %d, %v", n, err)
	}
	if ok, err := st.ConsumeRecoveryCode(ctx, u.ID, hash("a")); err != nil || !ok {
		t.Errorf("code = %v, %v", ok, err)
	}
	if ok, err := st.ConsumeRecoveryCode(ctx, u.ID, hash("a")); err != nil || ok {
		t.Errorf("reused code = %v, %v", ok, err)
	}

	if err := st.ClearTOTP(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	got, _ = st.UserByID(ctx, u.ID)
	if got.TOTPEnabled || got.TOTPSecret != nil || got.TOTPLastStep != 0 {
		t.Errorf("cleared = %+v", got)
	}
	if n, _ := st.CountRecoveryCodes(ctx, u.ID); n != 0 {
		t.Errorf("codes after clear = %d", n)
	}
	if err := st.ClearTOTP(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("ClearTOTP unknown: %v", err)
	}
}

func TestAudit(t *testing.T) {
	st := open(t)
	if err := st.AppendAudit(ctx, AuditEntry{At: t0, Action: "first", ActorID: "a", TargetID: "b", Remote: "1.2.3.4"}); err != nil {
		t.Fatal(err)
	}
	if err := st.AppendAudit(ctx, AuditEntry{At: t0, Action: "second"}); err != nil {
		t.Fatal(err)
	}
	got, err := st.ListAudit(ctx, 10)
	if err != nil || len(got) != 2 || got[0].Action != "second" || got[1] != (AuditEntry{ID: got[1].ID, At: t0, Action: "first", ActorID: "a", TargetID: "b", Remote: "1.2.3.4"}) {
		t.Fatalf("audit = %+v, %v", got, err)
	}
	if got, _ := st.ListAudit(ctx, 1); len(got) != 1 {
		t.Errorf("limit ignored: %+v", got)
	}
	if older, _ := st.ListAuditBefore(ctx, got[0].ID, 10); len(older) != 1 || older[0].Action != "first" {
		t.Errorf("before: %+v", older)
	}
	if n, err := st.TrimAudit(ctx, t0, 10); n != 0 || err != nil {
		t.Errorf("trimmed what is not older: %d, %v", n, err)
	}
	if n, err := st.TrimAudit(ctx, t0.Add(time.Second), 1); n != 1 || err != nil {
		t.Errorf("trim: %d, %v", n, err)
	}
	if left, _ := st.ListAudit(ctx, 10); len(left) != 1 || left[0].Action != "second" {
		t.Errorf("after the trim: %+v", left)
	}
}

func TestForeignKeysAreEnforced(t *testing.T) {
	st := open(t)
	err := st.CreateSession(ctx, Session{Hash: hash("s"), UserID: "nope", CreatedAt: t0, ExpiresAt: t0, AbsoluteAt: t0})
	if err == nil {
		t.Error("a session for an unknown user was accepted")
	}
}

func TestConcurrentWritesDoNotFail(t *testing.T) {
	st := open(t)
	errs := make(chan error, 20)
	for i := range 20 {
		go func() {
			errs <- st.AppendAudit(ctx, AuditEntry{At: t0.Add(time.Duration(i) * time.Second), Action: "x"})
		}()
	}
	for range 20 {
		if err := <-errs; err != nil {
			t.Error(err)
		}
	}
}

func TestErrNoRowsDoesNotLeak(t *testing.T) {
	st := open(t)
	if _, err := st.TokenByHash(ctx, hash("x")); errors.Is(err, sql.ErrNoRows) {
		t.Error("store returned a driver error for a missing record")
	}
}
