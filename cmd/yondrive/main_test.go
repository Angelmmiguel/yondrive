package main

import (
	"bytes"
	"context"
	"encoding/pem"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

func TestParseSecure(t *testing.T) {
	for in, want := range map[string]server.SecureMode{
		"":      server.SecureAuto,
		"auto":  server.SecureAuto,
		"AUTO":  server.SecureAuto,
		"true":  server.SecureAlways,
		"false": server.SecureNever,
	} {
		got, err := parseSecure(in)
		if err != nil || got != want {
			t.Errorf("parseSecure(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"yes", "1", "ture"} {
		if _, err := parseSecure(bad); err == nil {
			t.Errorf("parseSecure(%q) accepted", bad)
		}
	}
}

func TestParsePublicURL(t *testing.T) {
	for in, want := range map[string]string{
		"":                           "",
		"https://drive.example.com":  "https://drive.example.com",
		"https://drive.example.com/": "https://drive.example.com",
		"http://192.168.1.5:8990":    "http://192.168.1.5:8990",
	} {
		got, err := parsePublicURL(in)
		if err != nil || got != want {
			t.Errorf("parsePublicURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"drive.example.com", "ftp://x.example", "https://", "https://u:p@x.example", "https://x.example?a=b", "https://x.example#f"} {
		if _, err := parsePublicURL(bad); err == nil {
			t.Errorf("parsePublicURL(%q) accepted", bad)
		}
	}
}

func TestParsePrefixes(t *testing.T) {
	got, err := parsePrefixes(" 10.0.0.1, 192.168.0.0/16 ,fd00::1,,")
	if err != nil {
		t.Fatalf("parsePrefixes: %v", err)
	}
	want := []string{"10.0.0.1/32", "192.168.0.0/16", "fd00::1/128"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i].String() != want[i] {
			t.Errorf("prefix %d = %s, want %s", i, got[i], want[i])
		}
	}
	if got, err := parsePrefixes(""); err != nil || len(got) != 0 {
		t.Errorf("parsePrefixes(\"\") = %v, %v; want none", got, err)
	}
	for _, bad := range []string{"proxy", "10.0.0.0/33", "10.0.0"} {
		if _, err := parsePrefixes(bad); err == nil {
			t.Errorf("parsePrefixes(%q) accepted", bad)
		}
	}
}

func TestParseSettingsReadsTheEnvironmentAndFlagsWin(t *testing.T) {
	t.Setenv("YONDRIVE_ADDR", ":9000")
	t.Setenv("YONDRIVE_DATA", "/env/data")
	t.Setenv("YONDRIVE_SECURE", "false")
	t.Setenv("YONDRIVE_TRUSTED_PROXIES", "10.0.0.0/8")
	t.Setenv("YONDRIVE_PUBLIC_URL", "https://drive.example.com")

	s, err := parseSettings([]string{"--data", "/flag/data"})
	if err != nil {
		t.Fatalf("parseSettings: %v", err)
	}
	if s.addr != ":9000" || s.dataDir != "/flag/data" || s.secure != server.SecureNever ||
		len(s.proxies) != 1 || s.publicURL != "https://drive.example.com" {
		t.Errorf("settings = %+v", s)
	}
}

func TestParseSettingsRejectsBadValues(t *testing.T) {
	for _, args := range [][]string{
		{"--secure", "maybe"},
		{"--trusted-proxies", "nope"},
		{"--public-url", "nope"},
	} {
		if _, err := parseSettings(args); err == nil {
			t.Errorf("parseSettings(%v) accepted", args)
		}
	}
}

func TestSetupLog(t *testing.T) {
	for _, tc := range []struct {
		publicURL, addr string
		want            []string
	}{
		{"https://drive.example.com", ":8080", []string{"link=https://drive.example.com/setup#tok"}},
		{"", "127.0.0.1:8080", []string{"link=http://127.0.0.1:8080/setup#tok"}},
		{"", "nonsense", []string{"link=http://nonsense/setup#tok"}},
		// Every interface, as in a container whose port is mapped to another: no
		// link that names an address the browser cannot reach.
		{"", ":8080", []string{"path=/setup#tok", "listening=:8080", "host port mapped to 8080", "YONDRIVE_PUBLIC_URL"}},
		{"", "0.0.0.0:9000", []string{"path=/setup#tok", "listening=:9000"}},
		{"", "[::]:8080", []string{"path=/setup#tok"}},
	} {
		var out bytes.Buffer
		msg, attrs := setupLog(tc.publicURL, tc.addr, "tok")
		slog.New(slog.NewTextHandler(&out, nil)).Info(msg, attrs...)
		line := out.String()
		for _, want := range tc.want {
			if !strings.Contains(line, want) {
				t.Errorf("%q, %q: %s lacks %q", tc.publicURL, tc.addr, line, want)
			}
		}
		if strings.Contains(line, "localhost") {
			t.Errorf("%q, %q: %s names localhost", tc.publicURL, tc.addr, line)
		}
	}
}

func TestAdminResetTOTP(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	u := store.User{ID: store.NewID(), Username: "alice", Role: "user", CreatedAt: time.Now()}
	if err := st.CreateUser(ctx, u, "", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := st.SetPendingTOTP(ctx, u.ID, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	if err := st.EnableTOTP(ctx, u.ID, 1, 1, [][]byte{{1}}); err != nil {
		t.Fatal(err)
	}

	// The lock refuses the command while the server runs.
	if err := admin([]string{"reset-totp", "--data", dir, "alice"}); !errors.Is(err, store.ErrLocked) {
		t.Fatalf("with the store open: %v, want ErrLocked", err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	if err := admin([]string{"reset-totp", "--data", dir, "nobody"}); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("unknown user: %v", err)
	}
	if err := admin([]string{"reset-totp", "--data", dir, "ALICE"}); err != nil {
		t.Fatal(err)
	}

	st, err = store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	got, err := st.UserByID(ctx, u.ID)
	if err != nil || got.TOTPEnabled || got.TOTPSecret != nil {
		t.Errorf("user = %+v, %v", got, err)
	}
	entries, err := st.ListAudit(ctx, 1)
	if err != nil || len(entries) != 1 || entries[0].Action != "totp_reset_by_operator" || entries[0].TargetID != u.ID {
		t.Errorf("audit = %+v, %v", entries, err)
	}
}

func TestAdminRejectsBadUsage(t *testing.T) {
	stderr := os.Stderr
	devnull, err := os.Open(os.DevNull)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = devnull.Close() }()
	os.Stderr = devnull
	defer func() { os.Stderr = stderr }()
	for _, args := range [][]string{nil, {"nonsense"}, {"reset-totp", "--data", t.TempDir()}, {"reset-totp", "--data", t.TempDir(), "a", "b"}} {
		if err := admin(args); err == nil {
			t.Errorf("admin(%v) accepted", args)
		}
	}
}

func TestParseSettingsLoadsTheCAFile(t *testing.T) {
	if s, err := parseSettings(nil); err != nil || s.roots != nil {
		t.Fatalf("no file: %v, %v", s.roots, err)
	}
	if _, err := parseSettings([]string{"--ca-file", filepath.Join(t.TempDir(), "missing.pem")}); err == nil {
		t.Error("a missing file was accepted")
	}
	ts := httptest.NewTLSServer(http.NotFoundHandler())
	defer ts.Close()
	path := filepath.Join(t.TempDir(), "ca.pem")
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ts.Certificate().Raw})
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("YONDRIVE_CA_FILE", path)
	if s, err := parseSettings(nil); err != nil || s.roots == nil {
		t.Errorf("with a file: %v, %v", s.roots, err)
	}
}
