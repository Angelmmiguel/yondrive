package server_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const testSetupToken = "the-setup-token"

var ctx = context.Background()

// env is a server with its store and an adjustable clock.
type env struct {
	t     *testing.T
	ts    *httptest.Server
	st    *store.Store
	srv   *server.Server
	mu    sync.Mutex
	clock time.Time
}

func (e *env) advance(d time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.clock = e.clock.Add(d)
}

func (e *env) now() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.clock
}

func newEnv(t *testing.T, cfg server.Config) *env {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return startEnv(t, cfg, st)
}

func startEnv(t *testing.T, cfg server.Config, st *store.Store) *env {
	t.Helper()
	e := &env{t: t, st: st, clock: time.Unix(1_800_000_000, 0).UTC()}
	cfg.Now = e.now
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if cfg.SetupToken == "" {
		cfg.SetupToken = testSetupToken
	}
	if cfg.LoginAttempts == 0 {
		cfg.LoginAttempts = 1000
	}
	srv, err := server.New(cfg, st)
	if err != nil {
		t.Fatal(err)
	}
	e.srv = srv
	e.ts = httptest.NewServer(srv)
	t.Cleanup(e.ts.Close)
	return e
}

// response is a fully read response.
type response struct {
	status int
	header http.Header
	body   []byte
}

func (r response) code() string {
	var e struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(r.body, &e)
	return e.Code
}

// wantError fails unless the response is the given failure.
func (r response) wantError(t *testing.T, status int, code string) {
	t.Helper()
	if r.status != status || r.code() != code {
		t.Errorf("got %d %s, want %d %s", r.status, r.body, status, code)
	}
}

func (r response) wantStatus(t *testing.T, status int) {
	t.Helper()
	if r.status != status {
		t.Fatalf("got %d %s, want %d", r.status, r.body, status)
	}
}

func (r response) decode(t *testing.T, v any) {
	t.Helper()
	if err := json.Unmarshal(r.body, v); err != nil {
		t.Fatalf("decode %s: %v", r.body, err)
	}
}

// call sends a request. A string or []byte body goes as is; anything else is
// encoded as JSON. Headers come in pairs.
func (e *env) call(method, path string, body any, header ...string) response {
	e.t.Helper()
	var reader io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		reader = strings.NewReader(b)
	default:
		data, err := json.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, e.ts.URL+path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		e.t.Fatal(err)
	}
	return response{status: resp.StatusCode, header: resp.Header, body: data}
}

type obj = map[string]any

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func fill(b byte, n int) []byte { return bytes.Repeat([]byte{b}, n) }

// key returns a 32-byte auth key derived from a label.
func key(label string) []byte { return auth.HashToken(label) }

func kdf(saltByte byte) obj {
	return obj{"name": "argon2id", "m": 65536, "t": 3, "p": 1, "salt": b64(fill(saltByte, 16))}
}

func accountKeys(tag byte) obj {
	return obj{
		"wrapped_master_key":          b64(fill(tag, 72)),
		"wrapped_master_key_recovery": b64(fill(tag+1, 72)),
		"sealed_x25519":               b64(fill(tag+2, 72)),
		"sealed_ed25519":              b64(fill(tag+3, 72)),
		"public_keys":                 obj{"x25519": b64(fill(tag+4, 32)), "ed25519": b64(fill(tag+5, 32))},
	}
}

// account returns the fields of a new account in the given mode, whose auth key
// is key(username) and recovery auth key key(username+"-recovery").
func account(username, mode string) obj {
	a := obj{"username": username, "auth_key": b64(key(username)), "kdf": kdf(1)}
	if mode == "e2e" {
		a["recovery_auth_key"] = b64(key(username + "-recovery"))
		a["keys"] = accountKeys(10)
	}
	return a
}

func setupBody(mode string) obj {
	return obj{
		"settings": obj{
			"name":                "Home",
			"public_url":          "https://drive.example.com/",
			"default_quota_bytes": 1000,
			"language":            "en",
			"time_zone":           "Europe/Madrid",
			"mode":                mode,
		},
		"admin": account("root", mode),
	}
}

// audited reports whether the audit trail holds action.
func (e *env) audited(action string) bool {
	e.t.Helper()
	entries, err := e.st.ListAudit(ctx, 1000)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, a := range entries {
		if a.Action == action {
			return true
		}
	}
	return false
}

// startEnvNoToken starts a server that was given no setup token at all.
func startEnvNoToken(t *testing.T, st *store.Store) *env {
	t.Helper()
	e := &env{t: t, st: st, clock: time.Unix(1_800_000_000, 0).UTC()}
	srv, err := server.New(server.Config{Now: e.now, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, st)
	if err != nil {
		t.Fatal(err)
	}
	e.ts = httptest.NewServer(srv)
	t.Cleanup(e.ts.Close)
	return e
}

// configured returns a server set up in mode, with the admin "root".
func configured(t *testing.T, mode string, cfg server.Config) *env {
	t.Helper()
	e := newEnv(t, cfg)
	e.call(http.MethodPost, "/api/v1/setup/complete", setupBody(mode), "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
	return e
}

// client is one signed-in browser: it presents the session cookie it got.
type client struct {
	e      *env
	cookie string
	body   []byte
}

// loginWith signs in and returns the raw response.
func (e *env) loginWith(username string, authKey []byte, extra ...any) response {
	e.t.Helper()
	body := obj{"username": username, "auth_key": b64(authKey)}
	for i := 0; i+1 < len(extra); i += 2 {
		body[extra[i].(string)] = extra[i+1]
	}
	return e.call(http.MethodPost, "/api/v1/auth/login", body)
}

// login signs in with the key that account() gave username.
func (e *env) login(username string) *client {
	e.t.Helper()
	return e.loginKey(username, key(username))
}

func (e *env) loginKey(username string, authKey []byte, extra ...any) *client {
	e.t.Helper()
	resp := e.loginWith(username, authKey, extra...)
	resp.wantStatus(e.t, http.StatusOK)
	for _, c := range (&http.Response{Header: resp.header}).Cookies() {
		if c.Name == "yondrive_session" {
			return &client{e: e, cookie: c.Name + "=" + c.Value, body: resp.body}
		}
	}
	e.t.Fatal("no session cookie")
	return nil
}

func (c *client) call(method, path string, body any) response {
	c.e.t.Helper()
	return c.e.call(method, path, body, "Cookie", c.cookie)
}

// register creates an account through an open invite made by the given admin.
func (e *env) register(admin *client, username, mode string) string {
	e.t.Helper()
	resp := admin.call(http.MethodPost, "/api/v1/admin/invites", obj{})
	resp.wantStatus(e.t, http.StatusCreated)
	var inv struct {
		Token string `json:"token"`
	}
	resp.decode(e.t, &inv)
	resp = e.call(http.MethodPost, "/api/v1/auth/register", obj{"invite_token": inv.Token, "account": account(username, mode)})
	resp.wantStatus(e.t, http.StatusCreated)
	var created struct {
		UserID string `json:"user_id"`
	}
	resp.decode(e.t, &created)
	return created.UserID
}
