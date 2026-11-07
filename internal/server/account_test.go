package server_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const (
	kdfPath      = "/api/v1/auth/kdf?username="
	loginPath    = "/api/v1/auth/login"
	logoutPath   = "/api/v1/auth/logout"
	registerPath = "/api/v1/auth/register"
	rekeyPath    = "/api/v1/auth/rekey"
	sessionKey   = "/api/v1/session/key"
	mePath       = "/api/v1/me"
	invitesPath  = "/api/v1/admin/invites"
)

func TestRoutesNeedASession(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, logoutPath, nil},
		{http.MethodPost, rekeyPath, obj{"current_auth_key": b64(key("root"))}},
		{http.MethodGet, sessionKey, nil},
		{http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}},
		{http.MethodDelete, sessionKey, nil},
		{http.MethodGet, mePath, nil},
		{http.MethodGet, "/api/v1/users/x/keys", nil},
		{http.MethodGet, invitesPath, nil},
		{http.MethodPost, invitesPath, obj{}},
		{http.MethodDelete, invitesPath + "/x", nil},
	} {
		e.call(tc.method, tc.path, tc.body).wantError(t, http.StatusUnauthorized, "unauthorized")
		e.call(tc.method, tc.path, tc.body, "Cookie", "yondrive_session=made-up").wantError(t, http.StatusUnauthorized, "unauthorized")
	}
}

func TestOpenRoutesNeedSetup(t *testing.T) {
	e := newEnv(t, server.Config{})
	e.call(http.MethodGet, kdfPath+"a", nil).wantError(t, http.StatusConflict, "not_setup")
	e.loginWith("a", key("a")).wantError(t, http.StatusConflict, "not_setup")
	e.call(http.MethodPost, registerPath, obj{"account": account("a", "none")}).wantError(t, http.StatusConflict, "not_setup")
}

func TestKDFOfARealUser(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	for _, name := range []string{"root", "ROOT", "%20root"} {
		resp := e.call(http.MethodGet, kdfPath+name, nil)
		resp.wantStatus(t, http.StatusOK)
		var got, want any
		resp.decode(t, &got)
		data, _ := json.Marshal(kdf(1))
		_ = json.Unmarshal(data, &want)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %s", name, resp.body)
		}
	}
	e.call(http.MethodGet, "/api/v1/auth/kdf", nil).wantStatus(t, http.StatusBadRequest)
}

func TestFakeKDFIsStableAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := startEnv(t, server.Config{}, st)
	e.call(http.MethodPost, setupPath, setupBody("e2e"), "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
	first := e.call(http.MethodGet, kdfPath+"nobody", nil)
	first.wantStatus(t, http.StatusOK)
	if again := e.call(http.MethodGet, kdfPath+"NoBody", nil); !bytes.Equal(first.body, again.body) {
		t.Errorf("not stable: %s, %s", first.body, again.body)
	}
	if other := e.call(http.MethodGet, kdfPath+"somebody", nil); bytes.Equal(first.body, other.body) {
		t.Error("the same salt for two usernames")
	}
	e.ts.Close()
	_ = st.Close()

	st, err = store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e = startEnv(t, server.Config{}, st)
	if again := e.call(http.MethodGet, kdfPath+"nobody", nil); !bytes.Equal(first.body, again.body) {
		t.Errorf("changed across a restart: %s, %s", first.body, again.body)
	}
}

// A response for a fake user and one for a real user created by the client
// defaults must be the same document but for the random salt.
func TestFakeKDFIsIndistinguishableInShape(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	real, fake := e.call(http.MethodGet, kdfPath+"root", nil), e.call(http.MethodGet, kdfPath+"nobody", nil)
	real.wantStatus(t, http.StatusOK)
	fake.wantStatus(t, http.StatusOK)
	if !reflect.DeepEqual(real.header["Content-Type"], fake.header["Content-Type"]) {
		t.Error("content types differ")
	}
	if len(real.body) != len(fake.body) {
		t.Errorf("sizes differ: %s, %s", real.body, fake.body)
	}
	saltless := func(b []byte) string {
		i := bytes.Index(b, []byte(`"salt":"`))
		j := bytes.IndexByte(b[i+8:], '"')
		return string(b[:i+8]) + string(b[i+8+j:])
	}
	if saltless(real.body) != saltless(fake.body) {
		t.Errorf("shapes differ: %s, %s", real.body, fake.body)
	}
}

func TestKDFRateLimit(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 1})
	for range 6 {
		e.call(http.MethodGet, kdfPath+"a", nil).wantStatus(t, http.StatusOK)
	}
	e.call(http.MethodGet, kdfPath+"a", nil).wantError(t, http.StatusTooManyRequests, "rate_limited")
}

func TestLoginReturnsTheAccountBlob(t *testing.T) {
	e := configured(t, "e2e", server.Config{Secure: server.SecureAlways})
	resp := e.loginWith("Root", key("root"))
	resp.wantStatus(t, http.StatusOK)

	var got obj
	resp.decode(t, &got)
	if got["mode"] != "e2e" {
		t.Errorf("mode = %v", got["mode"])
	}
	want, _ := json.Marshal(accountKeys(10))
	have, _ := json.Marshal(got["keys"])
	var a, b any
	_ = json.Unmarshal(want, &a)
	_ = json.Unmarshal(have, &b)
	if !reflect.DeepEqual(a, b) {
		t.Errorf("keys = %s, want %s", have, want)
	}
	user := got["user"].(obj)
	if user["username"] != "root" || user["role"] != "admin" || user["quota_bytes"] != float64(1000) || user["totp_enabled"] != false {
		t.Errorf("user = %v", user)
	}
	if got["kdf"].(obj)["m"] != float64(65536) {
		t.Errorf("kdf = %v", got["kdf"])
	}

	cookie := resp.header.Get("Set-Cookie")
	for _, attr := range []string{"yondrive_session=", "HttpOnly", "SameSite=Strict", "Secure", "Path=/", "Max-Age=604800"} {
		if !strings.Contains(cookie, attr) {
			t.Errorf("cookie %q lacks %s", cookie, attr)
		}
	}
	if !e.audited("login_succeeded") {
		t.Error("no audit row")
	}
}

func TestLoginAcceptsTheRecoveryKey(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	e.loginKey("root", key("root-recovery"))
}

func TestCookieIsNotSecureOverPlainHTTP(t *testing.T) {
	e := configured(t, "none", server.Config{})
	if cookie := e.loginWith("root", key("root")).header.Get("Set-Cookie"); strings.Contains(cookie, "Secure") {
		t.Errorf("cookie = %q", cookie)
	}
}

func TestWrongCredentialsLookTheSame(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	wrongKey := e.loginWith("root", key("wrong"))
	unknown := e.loginWith("nobody", key("nobody"))
	short := e.loginWith("root", fill(1, 16))
	for _, r := range []response{wrongKey, unknown, short} {
		r.wantError(t, http.StatusUnauthorized, "invalid_credentials")
		if !bytes.Equal(r.body, wrongKey.body) {
			t.Errorf("bodies differ: %s, %s", r.body, wrongKey.body)
		}
		if r.header.Get("Set-Cookie") != "" {
			t.Error("a failed login set a cookie")
		}
	}
	if !e.audited("login_failed") {
		t.Error("no audit row")
	}
}

func TestLoginRateLimit(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 2})
	e.loginWith("root", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	e.loginWith("root", key("root")).wantStatus(t, http.StatusOK)
	// Even the right key: every attempt counts, whatever its outcome.
	e.loginWith("root", key("root")).wantError(t, http.StatusTooManyRequests, "rate_limited")
	e.advance(time.Minute)
	e.loginWith("root", key("root")).wantStatus(t, http.StatusOK)
}

func TestRateLimitFollowsTrustedProxiesOnly(t *testing.T) {
	limited := func(e *env, forwarded string) int {
		return e.call(http.MethodPost, loginPath, obj{"username": "root", "auth_key": b64(key("wrong"))}, "X-Forwarded-For", forwarded).status
	}
	e := configured(t, "none", server.Config{LoginAttempts: 1})
	if got := limited(e, "1.1.1.1"); got != http.StatusUnauthorized {
		t.Errorf("first = %d", got)
	}
	if got := limited(e, "2.2.2.2"); got != http.StatusTooManyRequests {
		t.Errorf("an untrusted forwarded address dodged the limit: %d", got)
	}

	e = configured(t, "none", server.Config{LoginAttempts: 1, TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
	if got := limited(e, "1.1.1.1"); got != http.StatusUnauthorized {
		t.Errorf("first client = %d", got)
	}
	if got := limited(e, "2.2.2.2"); got != http.StatusUnauthorized {
		t.Errorf("second client behind the proxy = %d", got)
	}
	// Only the entry the proxy appended counts, not what the client sent before it.
	if got := limited(e, "9.9.9.9, 1.1.1.1"); got != http.StatusTooManyRequests {
		t.Errorf("a spoofed chain dodged the limit: %d", got)
	}
}

func TestIPv6ClientsCountAsTheirSlash64(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 1, TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
	attempt := func(forwarded string) int {
		return e.call(http.MethodPost, loginPath, obj{"username": "nobody", "auth_key": b64(key("x"))}, "X-Forwarded-For", forwarded).status
	}
	if got := attempt("2001:db8:1:2::1"); got != http.StatusUnauthorized {
		t.Errorf("first = %d", got)
	}
	if got := attempt("2001:db8:1:2:ffff::9"); got != http.StatusTooManyRequests {
		t.Errorf("another address in the same /64 dodged the limit: %d", got)
	}
	if got := attempt("2001:db8:1:3::1"); got != http.StatusUnauthorized {
		t.Errorf("another /64 was limited: %d", got)
	}
	if got := attempt("192.0.2.1"); got != http.StatusUnauthorized {
		t.Errorf("IPv4 = %d", got)
	}
	if got := attempt("::ffff:192.0.2.1"); got != http.StatusTooManyRequests {
		t.Errorf("a mapped address counted apart from IPv4: %d", got)
	}
}

func TestAuditKeepsTheFullIPv6Address(t *testing.T) {
	e := configured(t, "none", server.Config{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
	e.call(http.MethodPost, loginPath, obj{"username": "root", "auth_key": b64(key("x"))}, "X-Forwarded-For", "2001:db8:1:2::1").wantStatus(t, http.StatusUnauthorized)
	entries, err := e.st.ListAudit(ctx, 1)
	if err != nil || len(entries) != 1 || entries[0].Remote != "2001:db8:1:2::1" {
		t.Errorf("audit = %+v, %v", entries, err)
	}
}

func TestLoginIsLimitedPerUsernameAcrossAddresses(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 1, TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
	from := func(i int, username string, authKey []byte) response {
		return e.call(http.MethodPost, loginPath, obj{"username": username, "auth_key": b64(authKey)}, "X-Forwarded-For", fmt.Sprintf("192.0.2.%d", i))
	}
	for i := range 5 {
		from(i, "ROOT", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	}
	from(5, "root", key("wrong")).wantError(t, http.StatusTooManyRequests, "rate_limited")
	// Unknown names behave alike, so the limit does not say who exists.
	for i := range 5 {
		from(10+i, "nobody", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	}
	from(15, "nobody", key("wrong")).wantError(t, http.StatusTooManyRequests, "rate_limited")
	// Other users go on, and the lockout lasts one window.
	from(16, "other", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	e.advance(time.Minute)
	from(0, "root", key("root")).wantStatus(t, http.StatusOK)
}

func TestSessionsSurviveAUsernameLockout(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 1, TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
	c := e.loginKey("root", key("root"))
	for i := range 6 {
		e.call(http.MethodPost, loginPath, obj{"username": "root", "auth_key": b64(key("x"))}, "X-Forwarded-For", fmt.Sprintf("192.0.2.%d", i))
	}
	e.loginWith("root", key("root")).wantStatus(t, http.StatusTooManyRequests)
	c.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)
}

func TestLongUsernamesTakeNoBucket(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 2, TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
	name := strings.Repeat("x", 65)
	for i := range 12 {
		e.call(http.MethodPost, loginPath, obj{"username": name, "auth_key": b64(key("x"))}, "X-Forwarded-For", fmt.Sprintf("192.0.2.%d", i)).
			wantError(t, http.StatusUnauthorized, "invalid_credentials")
	}
}

func TestSessionLifetimes(t *testing.T) {
	e := configured(t, "none", server.Config{SessionTTL: time.Hour, SessionMaxAge: 3 * time.Hour})
	c := e.login("root")
	c.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)

	// Use extends the idle window...
	for range 5 {
		e.advance(30 * time.Minute)
		c.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)
	}
	// ...but not past the absolute deadline.
	e.advance(30 * time.Minute)
	c.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")

	c = e.login("root")
	e.advance(time.Hour)
	c.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
}

func TestSessionsSurviveARestartButTheirKeysDoNot(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := startEnv(t, server.Config{}, st)
	e.call(http.MethodPost, setupPath, setupBody("none"), "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
	c := e.login("root")
	c.call(http.MethodPut, sessionKey, obj{"key": b64(fill(9, 32))}).wantStatus(t, http.StatusNoContent)
	e.ts.Close()
	_ = st.Close()

	st, err = store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e = startEnv(t, server.Config{}, st)
	c.e = e
	c.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)
	c.call(http.MethodGet, sessionKey, nil).wantError(t, http.StatusNotFound, "no_session_key")
}

func TestSessionTokensAreStoredHashed(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := startEnv(t, server.Config{}, st)
	e.call(http.MethodPost, setupPath, setupBody("none"), "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
	c := e.login("root")
	token := strings.TrimPrefix(c.cookie, "yondrive_session=")
	if _, err := st.SessionByHash(ctx, []byte(token)); err == nil {
		t.Error("the token itself is a key of the table")
	}
	if _, err := st.SessionByHash(ctx, auth.HashToken(token)); err != nil {
		t.Errorf("no session under the hash: %v", err)
	}
}

func TestSessionKeyRoutes(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	c.call(http.MethodGet, sessionKey, nil).wantError(t, http.StatusNotFound, "no_session_key")
	c.call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 31))}).wantError(t, http.StatusBadRequest, "invalid_session_key")
	c.call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}).wantStatus(t, http.StatusNoContent)
	c.call(http.MethodPut, sessionKey, obj{"key": b64(fill(2, 32))}).wantStatus(t, http.StatusNoContent)

	resp := c.call(http.MethodGet, sessionKey, nil)
	resp.wantStatus(t, http.StatusOK)
	var got struct {
		Key []byte `json:"key"`
	}
	resp.decode(t, &got)
	if !bytes.Equal(got.Key, fill(2, 32)) {
		t.Errorf("key = %x", got.Key)
	}

	other := e.login("root")
	other.call(http.MethodGet, sessionKey, nil).wantError(t, http.StatusNotFound, "no_session_key")

	c.call(http.MethodDelete, sessionKey, nil).wantStatus(t, http.StatusNoContent)
	c.call(http.MethodGet, sessionKey, nil).wantError(t, http.StatusNotFound, "no_session_key")
	c.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)
}

func TestSessionKeyIsClearedOnLogoutAndExpiry(t *testing.T) {
	e := configured(t, "e2e", server.Config{SessionTTL: time.Hour})
	put := func(c *client) {
		t.Helper()
		c.call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}).wantStatus(t, http.StatusNoContent)
	}
	c := e.login("root")
	put(c)
	resp := c.call(http.MethodPost, logoutPath, nil)
	resp.wantStatus(t, http.StatusNoContent)
	if !strings.Contains(resp.header.Get("Set-Cookie"), "Max-Age=0") {
		t.Errorf("cookie not cleared: %q", resp.header.Get("Set-Cookie"))
	}
	if n := e.srv.SessionKeyCount(); n != 0 {
		t.Errorf("%d keys after logout", n)
	}
	c.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")

	c = e.login("root")
	put(c)
	e.advance(time.Hour)
	c.call(http.MethodGet, sessionKey, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	if n := e.srv.SessionKeyCount(); n != 0 {
		t.Errorf("%d keys after expiry", n)
	}
}

func TestExpiredSessionsArePurgedWithoutARequest(t *testing.T) {
	e := configured(t, "e2e", server.Config{SessionTTL: time.Hour})
	e.login("root").call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}).wantStatus(t, http.StatusNoContent)
	e.advance(time.Hour)

	purge, stop := context.WithCancel(ctx)
	defer stop()
	go e.srv.PurgeExpiredSessions(purge, time.Millisecond)
	deadline := time.Now().Add(5 * time.Second)
	for e.srv.SessionKeyCount() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the key outlived its session")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSessionKeyIsNeverPersisted(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := startEnv(t, server.Config{}, st)
	e.call(http.MethodPost, setupPath, setupBody("e2e"), "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
	marker := bytes.Repeat([]byte("SESSIONKEY-MARK!"), 2)
	c := e.login("root")
	c.call(http.MethodPut, sessionKey, obj{"key": b64(marker)}).wantStatus(t, http.StatusNoContent)
	token := strings.TrimPrefix(c.cookie, "yondrive_session=")

	// Every byte in the data directory, write-ahead log included, while live
	// and after a clean close.
	scan := func(when string) {
		t.Helper()
		err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := os.ReadFile(path) //nolint:gosec // a test over its own temporary directory
			if err != nil {
				return err
			}
			for name, secret := range map[string][]byte{
				"session key":      marker,
				"encoded key":      []byte(b64(marker)),
				"session token":    []byte(token),
				"auth key":         key("root"),
				"recovery key":     key("root-recovery"),
				"encoded auth key": []byte(b64(key("root"))),
			} {
				if bytes.Contains(data, secret) {
					t.Errorf("%s: %s holds the %s", when, filepath.Base(path), name)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	scan("live")
	e.ts.Close()
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	scan("closed")
}

func TestRegisterWithAnInvite(t *testing.T) {
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) {
			e := configured(t, mode, server.Config{})
			admin := e.login("root")
			resp := admin.call(http.MethodPost, invitesPath, obj{"email": "A@b.example", "role": "admin", "quota_bytes": 77, "expires_in_seconds": 3600, "current_auth_key": b64(key("root"))})
			resp.wantStatus(t, http.StatusCreated)
			var inv struct {
				Token  string `json:"token"`
				Link   string `json:"link"`
				Invite struct {
					ID string `json:"id"`
				} `json:"invite"`
			}
			resp.decode(t, &inv)
			if inv.Link != "https://drive.example.com/invite#"+inv.Token {
				t.Errorf("link = %q", inv.Link)
			}

			body := obj{"invite_token": inv.Token, "account": account("Alice", mode)}
			e.call(http.MethodPost, registerPath, body).wantStatus(t, http.StatusCreated)
			u, err := e.st.UserByUsername(ctx, "alice")
			if err != nil {
				t.Fatal(err)
			}
			if u.Role != "admin" || u.QuotaBytes != 77 || u.Email != "A@b.example" {
				t.Errorf("user = %+v", u)
			}
			if (mode == "e2e") != (u.WrappedMasterKey != nil) || (mode == "e2e") != (u.RecoveryAuthKeyHash != nil) {
				t.Errorf("blobs do not fit the mode: %+v", u)
			}
			if !e.audited("user_registered") {
				t.Error("no audit row")
			}

			e.loginKey("alice", key("Alice"))

			// One-time.
			body = obj{"invite_token": inv.Token, "account": account("bob", mode)}
			e.call(http.MethodPost, registerPath, body).wantError(t, http.StatusForbidden, "invite_invalid")
		})
	}
}

func TestRegisterDefaultsFromTheServer(t *testing.T) {
	e := configured(t, "none", server.Config{})
	id := e.register(e.login("root"), "alice", "none")
	u, err := e.st.UserByID(ctx, id)
	if err != nil || u.Role != "user" || u.QuotaBytes != 1000 || u.Email != "" {
		t.Errorf("user = %+v, %v", u, err)
	}
}

func TestRegisterEnforcesTheMode(t *testing.T) {
	mint := func(t *testing.T, e *env) string {
		t.Helper()
		resp := e.login("root").call(http.MethodPost, invitesPath, obj{})
		resp.wantStatus(t, http.StatusCreated)
		var inv struct {
			Token string `json:"token"`
		}
		resp.decode(t, &inv)
		return inv.Token
	}
	e := configured(t, "e2e", server.Config{})
	token := mint(t, e)
	e.call(http.MethodPost, registerPath, obj{"invite_token": token, "account": account("a", "none")}).wantError(t, http.StatusBadRequest, "keys_required")

	e = configured(t, "none", server.Config{})
	token = mint(t, e)
	e.call(http.MethodPost, registerPath, obj{"invite_token": token, "account": account("a", "e2e")}).wantError(t, http.StatusBadRequest, "keys_not_allowed")
	// A refused request does not burn the invite.
	e.call(http.MethodPost, registerPath, obj{"invite_token": token, "account": account("a", "none")}).wantStatus(t, http.StatusCreated)
}

func TestRegisterConflicts(t *testing.T) {
	e := configured(t, "none", server.Config{})
	admin := e.login("root")
	mint := func() string {
		t.Helper()
		resp := admin.call(http.MethodPost, invitesPath, obj{})
		var inv struct {
			Token string `json:"token"`
		}
		resp.decode(t, &inv)
		return inv.Token
	}
	token := mint()
	e.call(http.MethodPost, registerPath, obj{"invite_token": token, "account": account("root", "none")}).wantError(t, http.StatusConflict, "username_taken")
	withEmail := account("alice", "none")
	withEmail["email"] = "a@b.example"
	e.call(http.MethodPost, registerPath, obj{"invite_token": token, "account": withEmail}).wantStatus(t, http.StatusCreated)
	dup := account("bob", "none")
	dup["email"] = "A@B.example"
	e.call(http.MethodPost, registerPath, obj{"invite_token": mint(), "account": dup}).wantError(t, http.StatusConflict, "email_taken")
}

func TestRegisterRefusesBadInvites(t *testing.T) {
	e := configured(t, "none", server.Config{})
	admin := e.login("root")
	body := func(token string) obj { return obj{"invite_token": token, "account": account("alice", "none")} }

	e.call(http.MethodPost, registerPath, body("made-up")).wantError(t, http.StatusForbidden, "invite_invalid")
	// Without an invite on a closed server, even a taken name says nothing.
	e.call(http.MethodPost, registerPath, obj{"account": account("root", "none")}).wantError(t, http.StatusForbidden, "signup_closed")

	resp := admin.call(http.MethodPost, invitesPath, obj{"expires_in_seconds": 60})
	var inv struct {
		Token string `json:"token"`
	}
	resp.decode(t, &inv)
	e.advance(time.Minute)
	e.call(http.MethodPost, registerPath, body(inv.Token)).wantError(t, http.StatusForbidden, "invite_invalid")
}

func TestRegisterIsRateLimited(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 1})
	e.call(http.MethodPost, registerPath, obj{"account": account("a", "none")}).wantError(t, http.StatusForbidden, "signup_closed")
	e.call(http.MethodPost, registerPath, obj{"account": account("a", "none")}).wantError(t, http.StatusTooManyRequests, "rate_limited")
}

func TestInviteAdminRoutes(t *testing.T) {
	e := configured(t, "none", server.Config{})
	admin := e.login("root")
	if resp := admin.call(http.MethodGet, invitesPath, nil); string(bytes.TrimSpace(resp.body)) != "[]" {
		t.Errorf("empty list = %s", resp.body)
	}
	for _, bad := range []struct {
		body obj
		code string
	}{
		{obj{"expires_in_seconds": 1}, "invalid_invite"},
		{obj{"expires_in_seconds": 91 * 24 * 3600}, "invalid_invite"},
		{obj{"role": "root"}, "invalid_invite"},
		{obj{"quota_bytes": -1}, "invalid_invite"},
		{obj{"email": "nope"}, "invalid_email"},
	} {
		admin.call(http.MethodPost, invitesPath, bad.body).wantError(t, http.StatusBadRequest, bad.code)
	}
	resp := admin.call(http.MethodPost, invitesPath, obj{"email": "a@b.example", "quota_bytes": 5})
	resp.wantStatus(t, http.StatusCreated)
	var created struct {
		Token  string `json:"token"`
		Invite struct {
			ID        string    `json:"id"`
			ExpiresAt time.Time `json:"expires_at"`
		} `json:"invite"`
	}
	resp.decode(t, &created)
	if want := e.now().Add(7 * 24 * time.Hour); !created.Invite.ExpiresAt.Equal(want) {
		t.Errorf("expires at %v, want %v", created.Invite.ExpiresAt, want)
	}
	if !e.audited("invite_created") {
		t.Error("no audit row")
	}

	list := admin.call(http.MethodGet, invitesPath, nil)
	list.wantStatus(t, http.StatusOK)
	if strings.Contains(string(list.body), created.Token) || !strings.Contains(string(list.body), created.Invite.ID) {
		t.Errorf("list = %s", list.body)
	}

	admin.call(http.MethodDelete, invitesPath+"/"+created.Invite.ID, nil).wantStatus(t, http.StatusNoContent)
	admin.call(http.MethodDelete, invitesPath+"/"+created.Invite.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	e.call(http.MethodPost, registerPath, obj{"invite_token": created.Token, "account": account("a", "none")}).wantError(t, http.StatusForbidden, "invite_invalid")
	if !e.audited("invite_revoked") {
		t.Error("no audit row")
	}
}

func TestAnAdminInviteNeedsTheAuthKey(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	root.call(http.MethodPost, invitesPath, obj{"role": "admin"}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	root.call(http.MethodPost, invitesPath, obj{"role": "admin", "current_auth_key": b64(key("wrong"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	if list := root.call(http.MethodGet, invitesPath, nil); string(bytes.TrimSpace(list.body)) != "[]" {
		t.Errorf("a refused invite was stored: %s", list.body)
	}
	root.call(http.MethodPost, invitesPath, obj{"role": "user"}).wantStatus(t, http.StatusCreated)
	root.call(http.MethodPost, invitesPath, obj{}).wantStatus(t, http.StatusCreated)
	root.call(http.MethodPost, invitesPath, obj{"role": "admin", "current_auth_key": b64(key("root"))}).wantStatus(t, http.StatusCreated)
}

func TestAdminInviteGuessesAreRateLimited(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 2})
	root := e.loginKey("root", key("root"))
	root.call(http.MethodPost, invitesPath, obj{"role": "admin"}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	root.call(http.MethodPost, invitesPath, obj{"role": "admin"}).wantError(t, http.StatusTooManyRequests, "rate_limited")
}

func TestAdminRoutesRefuseOrdinaryUsers(t *testing.T) {
	e := configured(t, "none", server.Config{})
	e.register(e.login("root"), "alice", "none")
	alice := e.login("alice")
	alice.call(http.MethodGet, invitesPath, nil).wantError(t, http.StatusForbidden, "forbidden")
	alice.call(http.MethodPost, invitesPath, obj{}).wantError(t, http.StatusForbidden, "forbidden")
	alice.call(http.MethodDelete, invitesPath+"/x", nil).wantError(t, http.StatusForbidden, "forbidden")
}

func TestGetMe(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	resp := c.call(http.MethodGet, mePath, nil)
	resp.wantStatus(t, http.StatusOK)
	var a, b any
	resp.decode(t, &a)
	_ = json.Unmarshal(c.body, &b)
	if !reflect.DeepEqual(a, b) {
		t.Errorf("me = %s, login = %s", resp.body, c.body)
	}
	if strings.Contains(string(resp.body), `"keys"`) {
		t.Errorf("keys in none mode: %s", resp.body)
	}
}

func TestUserKeys(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "e2e")
	resp := e.login("alice").call(http.MethodGet, "/api/v1/users/"+id+"/keys", nil)
	resp.wantStatus(t, http.StatusOK)
	var got struct {
		UserID     string `json:"user_id"`
		Username   string `json:"username"`
		PublicKeys struct {
			X25519  []byte `json:"x25519"`
			Ed25519 []byte `json:"ed25519"`
		} `json:"public_keys"`
	}
	resp.decode(t, &got)
	if got.UserID != id || got.Username != "alice" || !bytes.Equal(got.PublicKeys.X25519, fill(14, 32)) || !bytes.Equal(got.PublicKeys.Ed25519, fill(15, 32)) {
		t.Errorf("keys = %s", resp.body)
	}
	if strings.Contains(string(resp.body), "wrapped") || strings.Contains(string(resp.body), "sealed") {
		t.Errorf("private material in %s", resp.body)
	}
	root.call(http.MethodGet, "/api/v1/users/nope/keys", nil).wantError(t, http.StatusNotFound, "not_found")

	none := configured(t, "none", server.Config{})
	admin := none.login("root")
	var me struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	admin.call(http.MethodGet, mePath, nil).decode(t, &me)
	admin.call(http.MethodGet, "/api/v1/users/"+me.User.ID+"/keys", nil).wantError(t, http.StatusNotFound, "no_keys")
}

func passphraseRekey(current, next string) obj {
	return obj{
		"current_auth_key":   b64(key(current)),
		"auth_key":           b64(key(next)),
		"kdf":                kdf(2),
		"wrapped_master_key": b64(fill(99, 72)),
	}
}

func TestRekeyReplacesTheCredentialAndEndsOtherSessions(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	other := e.login("root")
	other.call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}).wantStatus(t, http.StatusNoContent)
	c.call(http.MethodPut, sessionKey, obj{"key": b64(fill(2, 32))}).wantStatus(t, http.StatusNoContent)

	c.call(http.MethodPost, rekeyPath, passphraseRekey("root", "root2")).wantStatus(t, http.StatusNoContent)

	other.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	if n := e.srv.SessionKeyCount(); n != 1 {
		t.Errorf("%d keys, want the caller's alone", n)
	}
	c.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)
	c.call(http.MethodGet, sessionKey, nil).wantStatus(t, http.StatusOK)

	e.loginWith("root", key("root")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	fresh := e.loginKey("root", key("root2"))
	var got struct {
		KDF struct {
			Salt []byte `json:"salt"`
		} `json:"kdf"`
		Keys struct {
			Wrapped  []byte `json:"wrapped_master_key"`
			Recovery []byte `json:"wrapped_master_key_recovery"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(fresh.body, &got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.KDF.Salt, fill(2, 16)) || !bytes.Equal(got.Keys.Wrapped, fill(99, 72)) || !bytes.Equal(got.Keys.Recovery, fill(11, 72)) {
		t.Errorf("account = %s", fresh.body)
	}
	// The recovery group was not part of this change.
	e.loginKey("root", key("root-recovery"))
	if !e.audited("credentials_rekeyed") {
		t.Error("no audit row")
	}
}

func TestRekeyWithTheRecoveryKey(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.loginKey("root", key("root-recovery"))
	c.call(http.MethodPost, rekeyPath, passphraseRekey("root-recovery", "new")).wantStatus(t, http.StatusNoContent)
	e.loginKey("root", key("new"))
}

func TestRekeyTheRecoveryGroup(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	c.call(http.MethodPost, rekeyPath, obj{
		"current_auth_key":            b64(key("root")),
		"recovery_auth_key":           b64(key("new-recovery")),
		"wrapped_master_key_recovery": b64(fill(77, 72)),
	}).wantStatus(t, http.StatusNoContent)
	e.loginWith("root", key("root-recovery")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	e.loginKey("root", key("new-recovery"))
	e.loginKey("root", key("root"))
}

func TestASessionAloneCannotRekey(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	before, _ := e.st.UserByUsername(ctx, "root")
	other := e.login("root")

	c.call(http.MethodPost, rekeyPath, passphraseRekey("wrong", "new")).wantError(t, http.StatusUnauthorized, "wrong_credential")
	noKey := passphraseRekey("root", "new")
	delete(noKey, "current_auth_key")
	c.call(http.MethodPost, rekeyPath, noKey).wantError(t, http.StatusUnauthorized, "wrong_credential")
	e.call(http.MethodPost, rekeyPath, passphraseRekey("root", "new")).wantError(t, http.StatusUnauthorized, "unauthorized")

	after, _ := e.st.UserByUsername(ctx, "root")
	if !reflect.DeepEqual(before, after) {
		t.Errorf("a refused rekey changed the user: %+v", after)
	}
	other.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)
	if !e.audited("credential_rejected") {
		t.Error("no audit row")
	}
}

func TestRekeyGroupsMustBeComplete(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	for _, tc := range []struct {
		name   string
		mutate func(obj)
		code   string
	}{
		{"nothing", func(b obj) { delete(b, "auth_key"); delete(b, "kdf"); delete(b, "wrapped_master_key") }, "invalid_rekey"},
		{"no auth key", func(b obj) { delete(b, "auth_key") }, "invalid_rekey"},
		{"no kdf", func(b obj) { delete(b, "kdf") }, "invalid_rekey"},
		{"no wrapped key", func(b obj) { delete(b, "wrapped_master_key") }, "invalid_rekey"},
		{"half a recovery group", func(b obj) { b["recovery_auth_key"] = b64(key("r")) }, "invalid_rekey"},
		{"other half", func(b obj) { b["wrapped_master_key_recovery"] = b64(fill(1, 72)) }, "invalid_rekey"},
		{"short auth key", func(b obj) { b["auth_key"] = b64(fill(1, 8)) }, "invalid_auth_key"},
		{"weak kdf", func(b obj) { b["kdf"] = obj{"name": "argon2id", "m": 1, "t": 1, "p": 1, "salt": b64(fill(1, 16))} }, "invalid_kdf"},
		{"small blob", func(b obj) { b["wrapped_master_key"] = b64(fill(1, 2)) }, "invalid_keys"},
		{"short recovery key", func(b obj) {
			b["recovery_auth_key"] = b64(fill(1, 8))
			b["wrapped_master_key_recovery"] = b64(fill(1, 72))
		}, "invalid_auth_key"},
		{"small recovery blob", func(b obj) {
			b["recovery_auth_key"] = b64(key("r"))
			b["wrapped_master_key_recovery"] = b64(fill(1, 2))
		}, "invalid_keys"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := passphraseRekey("root", "new")
			tc.mutate(body)
			c.call(http.MethodPost, rekeyPath, body).wantError(t, http.StatusBadRequest, tc.code)
		})
	}
	e.loginKey("root", key("root"))
}

func TestRekeyInNoneMode(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	body := obj{"current_auth_key": b64(key("root")), "auth_key": b64(key("new")), "kdf": kdf(3)}
	withKey := obj{"wrapped_master_key": b64(fill(1, 72))}
	for k, v := range body {
		withKey[k] = v
	}
	c.call(http.MethodPost, rekeyPath, withKey).wantError(t, http.StatusBadRequest, "keys_not_allowed")
	c.call(http.MethodPost, rekeyPath, obj{
		"current_auth_key":  b64(key("root")),
		"recovery_auth_key": b64(key("r")),
	}).wantError(t, http.StatusBadRequest, "keys_not_allowed")
	c.call(http.MethodPost, rekeyPath, body).wantStatus(t, http.StatusNoContent)
	e.loginKey("root", key("new"))
}

func TestRekeyIsRateLimited(t *testing.T) {
	e := configured(t, "e2e", server.Config{LoginAttempts: 2})
	c := e.login("root")
	c.call(http.MethodPost, rekeyPath, passphraseRekey("wrong", "new")).wantError(t, http.StatusUnauthorized, "wrong_credential")
	c.call(http.MethodPost, rekeyPath, passphraseRekey("wrong", "new")).wantError(t, http.StatusTooManyRequests, "rate_limited")
}

// A login racing a rekey may land before or after it, but must never leave a
// session opened on the retired key: the lock makes check and create one step.
func TestRekeyAndLoginDoNotInterleave(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	var wg sync.WaitGroup
	cookies := make([][]string, 8)
	for i := range cookies {
		wg.Go(func() {
			resp := e.loginWith("root", key("root"))
			if resp.status == http.StatusOK {
				cookies[i] = (&http.Response{Header: resp.header}).Header["Set-Cookie"]
			}
		})
	}
	wg.Go(func() {
		c.call(http.MethodPost, rekeyPath, passphraseRekey("root", "new")).wantStatus(t, http.StatusNoContent)
	})
	wg.Wait()
	live := 0
	for _, set := range cookies {
		for _, raw := range set {
			cookie := strings.SplitN(raw, ";", 2)[0]
			if e.call(http.MethodGet, mePath, nil, "Cookie", cookie).status == http.StatusOK {
				live++
			}
		}
	}
	if live != 0 {
		t.Errorf("%d sessions opened on the old key survive the rekey", live)
	}
}

func TestCSRFAppliesToCookieRoutes(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	for _, header := range [][]string{{"Sec-Fetch-Site", "cross-site"}, {"Origin", "https://evil.example"}} {
		e.call(http.MethodPost, logoutPath, nil, "Cookie", c.cookie, header[0], header[1]).wantError(t, http.StatusForbidden, "forbidden")
		e.call(http.MethodPost, loginPath, obj{"username": "root", "auth_key": b64(key("root"))}, header[0], header[1]).wantError(t, http.StatusForbidden, "forbidden")
	}
	c.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)
}

// The audit trail names events and addresses; it holds no secrets.
func TestAuditHoldsNoSecrets(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	e := startEnv(t, server.Config{}, st)
	e.call(http.MethodPost, setupPath, setupBody("e2e"), "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
	e.loginWith("typed-my-password-here", key("x")).wantStatus(t, http.StatusUnauthorized)
	e.login("root")

	entries, err := st.ListAudit(ctx, 100)
	if err != nil {
		t.Fatal(err)
	}
	var actions []string
	for _, a := range entries {
		actions = append(actions, a.Action)
		if strings.Contains(a.ActorID+a.TargetID+a.Remote+a.Action, "typed-my-password") {
			t.Errorf("a typed username reached the trail: %+v", a)
		}
	}
	if !slices.Contains(actions, "login_failed") {
		t.Errorf("actions = %v", actions)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "yondrive.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var columns int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('audit')`).Scan(&columns); err != nil || columns != 6 {
		t.Errorf("audit has %d columns, %v: review what a new one may hold", columns, err)
	}
}
