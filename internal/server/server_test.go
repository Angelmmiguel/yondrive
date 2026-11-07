package server_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	spec "github.com/Angelmmiguel/yondrive/api"
	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

func newServer(t *testing.T, cfg server.Config) *httptest.Server {
	t.Helper()
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	srv, err := server.New(cfg, st)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	return ts
}

func do(t *testing.T, ts *httptest.Server, method, path string, body io.Reader, header ...string) result {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return result{StatusCode: resp.StatusCode, Header: resp.Header, Body: string(b)}
}

// result is a fully read response.
type result struct {
	StatusCode int
	Header     http.Header
	Body       string
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	resp := do(t, newServer(t, server.Config{}), http.MethodGet, "/api/nothing", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if !strings.Contains(resp.Body, `"not_found"`) {
		t.Errorf("body = %q, want the not_found code", resp.Body)
	}
}

func TestUIIsServedForNonAPIPaths(t *testing.T) {
	ui := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "shell") })
	ts := newServer(t, server.Config{UI: ui})
	resp := do(t, ts, http.MethodGet, "/files/1", nil)
	if resp.Body != "shell" {
		t.Errorf("body = %q, want the UI", resp.Body)
	}
	if resp := do(t, ts, http.MethodGet, "/api/nothing", nil); resp.StatusCode != http.StatusNotFound {
		t.Errorf("API path status = %d, want 404", resp.StatusCode)
	}
}

func TestWithoutUINonAPIPathsAre404(t *testing.T) {
	if resp := do(t, newServer(t, server.Config{}), http.MethodGet, "/", nil); resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
}

func TestPanicBecomesJSON500(t *testing.T) {
	ui := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") })
	resp := do(t, newServer(t, server.Config{UI: ui}), http.MethodGet, "/", nil)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	if strings.Contains(resp.Body, "boom") {
		t.Errorf("body %q leaks the panic value", resp.Body)
	}
}

func TestSecurityHeaders(t *testing.T) {
	ts := newServer(t, server.Config{})
	resp := do(t, ts, http.MethodGet, "/api/nothing", nil)
	for k, want := range map[string]string{
		"X-Content-Type-Options":       "nosniff",
		"Referrer-Policy":              "no-referrer",
		"X-Frame-Options":              "DENY",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Resource-Policy": "same-origin",
		"Cache-Control":                "no-store",
	} {
		if got := resp.Header.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	if resp.Header.Get("Permissions-Policy") == "" {
		t.Error("Permissions-Policy missing")
	}
	if got := resp.Header.Get("Strict-Transport-Security"); got != "" {
		t.Errorf("HSTS = %q over plain HTTP, want none", got)
	}
	if got := resp.Header.Get("Content-Security-Policy"); got != "" {
		t.Errorf("CSP = %q, want none (the web app owns it)", got)
	}
}

func TestHSTSFollowsSecureMode(t *testing.T) {
	always := newServer(t, server.Config{Secure: server.SecureAlways})
	if resp := do(t, always, http.MethodGet, "/", nil); resp.Header.Get("Strict-Transport-Security") == "" {
		t.Error("secure=true: HSTS missing")
	}

	never := newServer(t, server.Config{Secure: server.SecureNever, TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}})
	resp := do(t, never, http.MethodGet, "/", nil, "X-Forwarded-Proto", "https")
	if resp.Header.Get("Strict-Transport-Security") != "" {
		t.Error("secure=false: HSTS sent")
	}
}

func TestAutoSecureBelievesOnlyTrustedProxies(t *testing.T) {
	trusted := newServer(t, server.Config{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
	if resp := do(t, trusted, http.MethodGet, "/", nil, "X-Forwarded-Proto", "https"); resp.Header.Get("Strict-Transport-Security") == "" {
		t.Error("trusted proxy reporting https: HSTS missing")
	}
	if resp := do(t, trusted, http.MethodGet, "/", nil, "X-Forwarded-Proto", "http"); resp.Header.Get("Strict-Transport-Security") != "" {
		t.Error("trusted proxy reporting http: HSTS sent")
	}

	untrusted := newServer(t, server.Config{})
	if resp := do(t, untrusted, http.MethodGet, "/", nil, "X-Forwarded-Proto", "https"); resp.Header.Get("Strict-Transport-Security") != "" {
		t.Error("untrusted peer: forwarded proto believed")
	}
}

func TestCSRFRejectsCrossSiteWrites(t *testing.T) {
	ts := newServer(t, server.Config{})
	for _, tc := range []struct {
		name   string
		method string
		header []string
		want   int
	}{
		{"cross-site POST", http.MethodPost, []string{"Sec-Fetch-Site", "cross-site"}, http.StatusForbidden},
		{"same-site POST", http.MethodPost, []string{"Sec-Fetch-Site", "same-site"}, http.StatusForbidden},
		{"foreign origin", http.MethodPut, []string{"Origin", "https://evil.example"}, http.StatusForbidden},
		{"same-origin POST", http.MethodPost, []string{"Sec-Fetch-Site", "same-origin"}, http.StatusNotFound},
		{"non-browser POST", http.MethodPost, nil, http.StatusNotFound},
		{"cross-site GET", http.MethodGet, []string{"Sec-Fetch-Site", "cross-site"}, http.StatusNotFound},
	} {
		if resp := do(t, ts, tc.method, "/api/nothing", nil, tc.header...); resp.StatusCode != tc.want {
			t.Errorf("%s: status = %d, want %d", tc.name, resp.StatusCode, tc.want)
		}
	}
}

func TestBodyLimit(t *testing.T) {
	var readErr error
	ui := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, readErr = io.Copy(io.Discard, r.Body)
	})
	ts := newServer(t, server.Config{UI: ui, MaxBodyBytes: 16})
	do(t, ts, http.MethodPost, "/", strings.NewReader(strings.Repeat("x", 64)))
	if readErr == nil {
		t.Error("a 64 byte body passed a 16 byte limit")
	}
}

func TestStalledBodyIsCutOff(t *testing.T) {
	done := make(chan error, 1)
	ui := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := io.Copy(io.Discard, r.Body)
		done <- err
	})
	ts := newServer(t, server.Config{UI: ui, BodyTimeout: 200 * time.Millisecond})

	pr, pw := io.Pipe()
	t.Cleanup(func() { _ = pw.Close() })
	go func() {
		resp, err := ts.Client().Post(ts.URL+"/", "text/plain", pr)
		if err == nil {
			_ = resp.Body.Close()
		}
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Error("stalled body read returned no error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a body that never completes was not cut off")
	}
}

func TestHealthBeforeSetup(t *testing.T) {
	bundle := strings.Repeat("ab", 32)
	ts := newServer(t, server.Config{Version: "1.2.3", Commit: "c0ffee", WebBundle: bundle})
	resp := do(t, ts, http.MethodGet, "/api/v1/health", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got struct {
		Status    string  `json:"status"`
		Version   string  `json:"version"`
		Commit    string  `json:"commit"`
		WebBundle string  `json:"web_bundle"`
		Setup     bool    `json:"setup"`
		Mode      *string `json:"mode"`
	}
	if err := json.Unmarshal([]byte(resp.Body), &got); err != nil {
		t.Fatalf("body %q: %v", resp.Body, err)
	}
	if got.Status != "ok" || got.Version != "1.2.3" || got.Commit != "c0ffee" || got.WebBundle != bundle || got.Setup || got.Mode != nil {
		t.Errorf("health = %+v", got)
	}
}

func TestHealthRejectsOtherMethods(t *testing.T) {
	resp := do(t, newServer(t, server.Config{}), http.MethodPost, "/api/v1/health", nil)
	if resp.StatusCode != http.StatusMethodNotAllowed && resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 405 or 404", resp.StatusCode)
	}
}

func TestServesTheEmbeddedSpec(t *testing.T) {
	resp := do(t, newServer(t, server.Config{}), http.MethodGet, "/api/openapi.yaml", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/yaml" {
		t.Errorf("Content-Type = %q, want application/yaml", ct)
	}
	if resp.Body != string(spec.YAML) {
		t.Error("served document differs from the embedded one")
	}
	if !strings.HasPrefix(resp.Body, "openapi: 3.1") {
		t.Errorf("document starts %.20q, want an OpenAPI 3.1 header", resp.Body)
	}
}
