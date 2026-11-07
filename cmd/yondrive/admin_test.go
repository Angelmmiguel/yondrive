package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// configuredStore is a data directory set up in a mode, with a disabled user
// and an account that signs in only through a provider. The store is closed, as
// the admin commands need the server stopped.
func configuredStore(t *testing.T, mode string) (dir string, alice, sso store.User) {
	t.Helper()
	dir = t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	ctx := context.Background()
	root := store.User{ID: store.NewID(), Username: "root", Role: "admin", CreatedAt: t0,
		Credentials: store.Credentials{AuthKeyHash: auth.HashToken("root")}}
	if err := st.CompleteSetup(ctx, store.Settings{Mode: mode, Name: "Home", PublicURL: "https://drive.example.com", LocalAccounts: true}, root); err != nil {
		t.Fatal(err)
	}
	alice = store.User{ID: store.NewID(), Username: "alice", Role: "user", CreatedAt: t0,
		Credentials: store.Credentials{AuthKeyHash: auth.HashToken("alice")}}
	sso = store.User{ID: store.NewID(), Username: "sso", Role: "user", CreatedAt: t0}
	for _, u := range []store.User{alice, sso} {
		if err := st.CreateUser(ctx, u, "", t0); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.DisableUser(ctx, alice.ID, t0); err != nil {
		t.Fatal(err)
	}
	return dir, alice, sso
}

func reopen(t *testing.T, dir string) *store.Store {
	t.Helper()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func lastAudit(t *testing.T, st *store.Store) store.AuditEntry {
	t.Helper()
	entries, err := st.ListAudit(context.Background(), 1)
	if err != nil || len(entries) != 1 {
		t.Fatalf("audit = %+v, %v", entries, err)
	}
	return entries[0]
}

func TestAdminPromote(t *testing.T) {
	dir, alice, _ := configuredStore(t, "e2e")
	var out bytes.Buffer
	if err := promote(dir, "nobody", &out); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unknown user: %v", err)
	}
	if err := promote(dir, " Alice ", &out); err != nil {
		t.Fatal(err)
	}
	st := reopen(t, dir)
	got, err := st.UserByID(context.Background(), alice.ID)
	if err != nil || got.Role != "admin" || got.Disabled {
		t.Errorf("alice = %+v, %v", got, err)
	}
	if a := lastAudit(t, st); a.Action != "promoted_by_operator" || a.TargetID != alice.ID {
		t.Errorf("audit = %+v", a)
	}
}

func TestAdminPasswordReset(t *testing.T) {
	dir, alice, _ := configuredStore(t, "e2e")
	var out bytes.Buffer
	if err := operatorPasswordReset(dir, "alice", &out); err == nil || !strings.Contains(err.Error(), "recovery key") {
		t.Errorf("end-to-end mode: %v", err)
	}

	dir, alice, _ = configuredStore(t, "none")
	if err := operatorPasswordReset(dir, "sso", &out); err == nil {
		t.Error("a reset link for an account that signs in only through a provider")
	}
	if err := operatorPasswordReset(dir, "alice", &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	link := lines[len(lines)-1]
	token, ok := strings.CutPrefix(link, "https://drive.example.com/reset#")
	if !ok {
		t.Fatalf("output = %q", out.String())
	}
	st := reopen(t, dir)
	ctx := context.Background()
	up := store.CredentialUpdate{AuthKeyHash: auth.HashToken("new"), KDF: []byte("{}")}
	if id, _, err := st.ConsumePasswordReset(ctx, auth.HashToken(token), up, time.Now()); err != nil || id != alice.ID {
		t.Errorf("the link does not reset alice: %s, %v", id, err)
	}
	if a := lastAudit(t, st); a.Action != "password_reset_by_operator" || a.TargetID != alice.ID {
		t.Errorf("audit = %+v", a)
	}
}

func TestAdminDispatchesEveryCommand(t *testing.T) {
	dir, _, _ := configuredStore(t, "none")
	for _, cmd := range []string{"reset-totp", "promote", "password-reset"} {
		if err := admin([]string{cmd, "--data", dir, "nobody"}); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("admin %s: %v", cmd, err)
		}
	}
}
