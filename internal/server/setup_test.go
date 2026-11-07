package server_test

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const setupPath = "/api/v1/setup/complete"

func TestSetupRoutesRequireTheToken(t *testing.T) {
	e := newEnv(t, server.Config{})
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/v1/setup/info", nil},
		{http.MethodPost, "/api/v1/setup/validate-url", obj{"url": "http://x"}},
		{http.MethodPost, setupPath, setupBody("e2e")},
	} {
		e.call(tc.method, tc.path, tc.body).wantError(t, http.StatusUnauthorized, "setup_token_invalid")
		e.call(tc.method, tc.path, tc.body, "X-Setup-Token", "wrong").wantError(t, http.StatusUnauthorized, "setup_token_invalid")
	}
	if _, err := e.st.Settings(ctx); !errors.Is(err, store.ErrNotConfigured) {
		t.Errorf("settings written without the token: %v", err)
	}
}

func TestServerWithoutATokenCannotBeSetUp(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := startEnvNoToken(t, st)
	e.call(http.MethodPost, setupPath, setupBody("e2e"), "X-Setup-Token", "").wantError(t, http.StatusUnauthorized, "setup_token_invalid")
}

func TestSetupTokenGuessesAreRateLimited(t *testing.T) {
	e := newEnv(t, server.Config{LoginAttempts: 2})
	path := "/api/v1/setup/info"
	for range 2 {
		e.call(http.MethodGet, path, nil).wantError(t, http.StatusUnauthorized, "setup_token_invalid")
	}
	e.call(http.MethodGet, path, nil).wantError(t, http.StatusTooManyRequests, "rate_limited")
	for range 5 {
		e.call(http.MethodGet, path, nil, "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusOK)
	}
}

func TestSetupInfo(t *testing.T) {
	dir := t.TempDir()
	e := newEnv(t, server.Config{DataDir: dir, PublicURL: "https://x.example", Version: "9"})
	resp := e.call(http.MethodGet, "/api/v1/setup/info", nil, "X-Setup-Token", testSetupToken)
	resp.wantStatus(t, http.StatusOK)
	var got struct {
		DataDir   string `json:"data_dir"`
		FreeBytes *int64 `json:"free_bytes"`
		PublicURL string `json:"public_url"`
		Version   string `json:"version"`
	}
	resp.decode(t, &got)
	if got.DataDir != dir || got.FreeBytes == nil || *got.FreeBytes <= 0 || got.PublicURL != "https://x.example" || got.Version != "9" {
		t.Errorf("info = %s", resp.body)
	}
}

func TestSetupInfoHasNoWayToChangeTheDataDir(t *testing.T) {
	e := newEnv(t, server.Config{})
	if resp := e.call(http.MethodPut, "/api/v1/setup/info", obj{"data_dir": "/etc"}, "X-Setup-Token", testSetupToken); resp.status == http.StatusOK {
		t.Errorf("status = %d", resp.status)
	}
}

func TestValidateURL(t *testing.T) {
	e := newEnv(t, server.Config{})
	check := func(in, want string, insecure bool) {
		t.Helper()
		resp := e.call(http.MethodPost, "/api/v1/setup/validate-url", obj{"url": in}, "X-Setup-Token", testSetupToken)
		resp.wantStatus(t, http.StatusOK)
		var got struct {
			URL      string `json:"url"`
			Insecure bool   `json:"insecure"`
		}
		resp.decode(t, &got)
		if got.URL != want || got.Insecure != insecure {
			t.Errorf("%q: %s", in, resp.body)
		}
	}
	check("https://drive.example.com/", "https://drive.example.com", false)
	check("http://192.168.1.5:8990", "http://192.168.1.5:8990", true)
	for _, bad := range []string{"", "drive.example.com", "ftp://x", "https://u:p@x", "https://x?a=b", "https://x#f"} {
		e.call(http.MethodPost, "/api/v1/setup/validate-url", obj{"url": bad}, "X-Setup-Token", testSetupToken).
			wantError(t, http.StatusBadRequest, "invalid_public_url")
	}
}

func TestCompleteSetupBurnsTheTokenAndWritesTheMode(t *testing.T) {
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) {
			e := newEnv(t, server.Config{})
			resp := e.call(http.MethodPost, setupPath, setupBody(mode), "X-Setup-Token", testSetupToken)
			resp.wantStatus(t, http.StatusCreated)
			var created struct {
				UserID string `json:"user_id"`
			}
			resp.decode(t, &created)

			got, err := e.st.Settings(ctx)
			if err != nil {
				t.Fatal(err)
			}
			want := store.Settings{
				Mode: mode, Name: "Home", PublicURL: "https://drive.example.com", DefaultQuotaBytes: 1000, Language: "en", TimeZone: "Europe/Madrid",
				PurgeGraceDays: store.DefaultPurgeGraceDays, TrashRetentionDays: store.DefaultTrashRetentionDays,
				AuditRetentionDays: store.DefaultAuditRetentionDays, JournalRetentionDays: store.DefaultJournalRetentionDays,
				LocalAccounts: true, OIDC: store.DefaultOIDCSettings(),
			}
			if got != want {
				t.Errorf("settings = %+v", got)
			}
			admin, err := e.st.UserByUsername(ctx, "root")
			if err != nil || admin.ID != created.UserID || admin.Role != "admin" || admin.QuotaBytes != 1000 {
				t.Fatalf("admin = %+v, %v", admin, err)
			}
			if bytes.Equal(admin.AuthKeyHash, key("root")) || len(admin.AuthKeyHash) != 32 {
				t.Error("the auth key is not hashed")
			}
			if (mode == "e2e") != (admin.WrappedMasterKey != nil && admin.RecoveryAuthKeyHash != nil) {
				t.Errorf("blobs do not fit the mode: %+v", admin)
			}
			if !e.audited("setup_completed") {
				t.Error("no audit row")
			}

			health := e.call(http.MethodGet, "/api/v1/health", nil)
			if !strings.Contains(string(health.body), `"setup":true`) || !strings.Contains(string(health.body), `"mode":"`+mode+`"`) {
				t.Errorf("health = %s", health.body)
			}

			// Burnt: the same token now opens nothing.
			for _, tc := range []struct {
				method, path string
				body         any
			}{
				{http.MethodGet, "/api/v1/setup/info", nil},
				{http.MethodPost, "/api/v1/setup/validate-url", obj{"url": "http://x"}},
				{http.MethodPost, setupPath, setupBody("none")},
			} {
				e.call(tc.method, tc.path, tc.body, "X-Setup-Token", testSetupToken).wantError(t, http.StatusConflict, "already_setup")
			}
			if got, _ := e.st.Settings(ctx); got.Mode != mode {
				t.Errorf("mode changed to %q", got.Mode)
			}
		})
	}
}

func TestConfiguredServerSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := startEnv(t, server.Config{}, st)
	e.call(http.MethodPost, setupPath, setupBody("none"), "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
	e.ts.Close()
	_ = st.Close()

	st, err = store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e = startEnv(t, server.Config{SetupToken: "a-new-one"}, st)
	if !strings.Contains(string(e.call(http.MethodGet, "/api/v1/health", nil).body), `"mode":"none"`) {
		t.Error("mode lost across a restart")
	}
	e.call(http.MethodPost, setupPath, setupBody("e2e"), "X-Setup-Token", "a-new-one").wantError(t, http.StatusConflict, "already_setup")
}

func TestCompleteSetupValidates(t *testing.T) {
	e := newEnv(t, server.Config{})
	for _, tc := range []struct {
		name   string
		mutate func(obj)
		code   string
	}{
		{"mode", func(b obj) { b["settings"].(obj)["mode"] = "maybe" }, "invalid_mode"},
		{"url", func(b obj) { b["settings"].(obj)["public_url"] = "ftp://x" }, "invalid_public_url"},
		{"name", func(b obj) { b["settings"].(obj)["name"] = " " }, "invalid_settings"},
		{"control character", func(b obj) { b["settings"].(obj)["name"] = "a\nb" }, "invalid_settings"},
		{"quota", func(b obj) { b["settings"].(obj)["default_quota_bytes"] = -1 }, "invalid_settings"},
		{"language", func(b obj) { b["settings"].(obj)["language"] = "english!" }, "invalid_settings"},
		{"time zone", func(b obj) { b["settings"].(obj)["time_zone"] = "../../etc" }, "invalid_settings"},
		{"username", func(b obj) { b["admin"].(obj)["username"] = "-bad" }, "invalid_username"},
		{"email", func(b obj) { b["admin"].(obj)["email"] = "nope" }, "invalid_email"},
		{"short auth key", func(b obj) { b["admin"].(obj)["auth_key"] = b64(fill(1, 16)) }, "invalid_auth_key"},
		{"short recovery key", func(b obj) { b["admin"].(obj)["recovery_auth_key"] = b64(fill(1, 16)) }, "invalid_auth_key"},
		{"weak kdf", func(b obj) { b["admin"].(obj)["kdf"].(obj)["m"] = 1024 }, "invalid_kdf"},
		{"kdf name", func(b obj) { b["admin"].(obj)["kdf"].(obj)["name"] = "scrypt" }, "invalid_kdf"},
		{"short salt", func(b obj) { b["admin"].(obj)["kdf"].(obj)["salt"] = b64(fill(1, 8)) }, "invalid_kdf"},
		{"no keys", func(b obj) { delete(b["admin"].(obj), "keys") }, "keys_required"},
		{"no recovery", func(b obj) { delete(b["admin"].(obj), "recovery_auth_key") }, "keys_required"},
		{"small blob", func(b obj) { b["admin"].(obj)["keys"].(obj)["sealed_x25519"] = b64(fill(1, 4)) }, "invalid_keys"},
		{"large blob", func(b obj) { b["admin"].(obj)["keys"].(obj)["wrapped_master_key"] = b64(fill(1, 4096)) }, "invalid_keys"},
		{"public key", func(b obj) { b["admin"].(obj)["keys"].(obj)["public_keys"].(obj)["x25519"] = b64(fill(1, 31)) }, "invalid_keys"},
		{"bad base64", func(b obj) { b["admin"].(obj)["auth_key"] = "not base64!" }, "bad_request"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := setupBody("e2e")
			tc.mutate(body)
			e.call(http.MethodPost, setupPath, body, "X-Setup-Token", testSetupToken).wantError(t, http.StatusBadRequest, tc.code)
		})
	}

	none := setupBody("none")
	none["admin"].(obj)["keys"] = accountKeys(1)
	e.call(http.MethodPost, setupPath, none, "X-Setup-Token", testSetupToken).wantError(t, http.StatusBadRequest, "keys_not_allowed")
	none = setupBody("none")
	none["admin"].(obj)["recovery_auth_key"] = b64(key("r"))
	e.call(http.MethodPost, setupPath, none, "X-Setup-Token", testSetupToken).wantError(t, http.StatusBadRequest, "keys_not_allowed")

	if _, err := e.st.Settings(ctx); !errors.Is(err, store.ErrNotConfigured) {
		t.Errorf("a rejected setup was stored: %v", err)
	}
	// The token survives failures.
	e.call(http.MethodPost, setupPath, setupBody("e2e"), "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
}

func TestConcurrentSetupsHaveOneWinner(t *testing.T) {
	e := newEnv(t, server.Config{})
	var wg sync.WaitGroup
	statuses := make([]int, 8)
	for i := range statuses {
		wg.Go(func() {
			mode := "e2e"
			if i%2 == 0 {
				mode = "none"
			}
			statuses[i] = e.call(http.MethodPost, setupPath, setupBody(mode), "X-Setup-Token", testSetupToken).status
		})
	}
	wg.Wait()
	created := 0
	for _, s := range statuses {
		switch s {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
		default:
			t.Errorf("status %d", s)
		}
	}
	if created != 1 {
		t.Errorf("%d setups succeeded", created)
	}
}

func TestBodyOverTheCapIsTooLarge(t *testing.T) {
	e := newEnv(t, server.Config{MaxBodyBytes: 64})
	e.call(http.MethodPost, setupPath, setupBody("e2e"), "X-Setup-Token", testSetupToken).wantError(t, http.StatusRequestEntityTooLarge, "too_large")
}

func TestMalformedJSONIsBadRequest(t *testing.T) {
	e := newEnv(t, server.Config{})
	e.call(http.MethodPost, setupPath, "{", "X-Setup-Token", testSetupToken).wantError(t, http.StatusBadRequest, "bad_request")
}

func TestSetupRejectedTokenIsNotLogged(t *testing.T) {
	var logs syncBuffer
	e := newEnv(t, server.Config{Logger: slog.New(slog.NewTextHandler(&logs, nil))})
	e.call(http.MethodGet, "/api/v1/setup/info", nil, "X-Setup-Token", "a-guessed-token")
	e.call(http.MethodGet, "/api/v1/setup/info", nil, "X-Setup-Token", testSetupToken)
	if strings.Contains(logs.String(), "a-guessed-token") || strings.Contains(logs.String(), testSetupToken) {
		t.Errorf("a token reached the logs: %s", logs.String())
	}
}

// syncBuffer is a log destination that handlers may write to concurrently.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
