package server_test

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/oidc/oidctest"
	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const settingsRoute = "/api/v1/admin/settings"

// browser is what these tests walk through a sign-in with: it follows no redirects,
// so that each hop can be looked at, and it keeps cookies by hand.
var browser = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// ssoFixture is a server with a local provider set up.
type ssoFixture struct {
	t    *testing.T
	e    *env
	fake *oidctest.Provider
	root *client
	mode string
}

func oidcInput(fake *oidctest.Provider, extra obj) obj {
	o := obj{
		"enabled": true, "label": "Fake ID", "issuer": fake.Issuer(), "client_id": oidctest.ClientID,
		"client_secret": oidctest.ClientSecret, "allow_insecure": true,
	}
	for k, v := range extra {
		o[k] = v
	}
	return o
}

func newSSO(t *testing.T, mode string, extra obj) *ssoFixture {
	t.Helper()
	day := 24 * time.Hour
	e := newEnv(t, server.Config{SessionTTL: 3650 * day, SessionMaxAge: 3650 * day})
	setup := setupBody(mode)
	setup["admin"].(obj)["email"] = "root@example.com"
	e.call(http.MethodPost, setupPath, setup, "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
	fake := oidctest.New(t)
	fake.Now = e.now
	root := e.login("root")
	root.call(http.MethodPatch, settingsRoute, obj{"oidc": oidcInput(fake, extra), "current_auth_key": b64(key("root"))}).wantStatus(t, http.StatusOK)
	return &ssoFixture{t: t, e: e, fake: fake, root: root, mode: mode}
}

// who sets who signs in next.
func (s *ssoFixture) who(sub string, claims obj) {
	c := map[string]any{"sub": sub}
	for k, v := range claims {
		c[k] = v
	}
	s.fake.Claims = c
}

// hop is one redirect of a sign-in.
type hop struct {
	StatusCode int
	Header     http.Header
}

func (s *ssoFixture) get(target string, cookies ...*http.Cookie) hop {
	s.t.Helper()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		s.t.Fatal(err)
	}
	for _, c := range cookies {
		req.AddCookie(c)
	}
	resp, err := browser.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return hop{StatusCode: resp.StatusCode, Header: resp.Header}
}

func cookieNamed(resp hop, name string) *http.Cookie {
	for _, c := range (&http.Response{Header: resp.Header}).Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// leave goes to the provider and back, and returns the query it comes back with and
// the flow cookie: everything but the last hop.
func (s *ssoFixture) leave(startQuery string) (url.Values, *http.Cookie) {
	s.t.Helper()
	resp := s.get(s.e.ts.URL + "/api/v1/auth/oidc/start" + startQuery)
	if resp.StatusCode != http.StatusFound {
		s.t.Fatalf("start: %d", resp.StatusCode)
	}
	flow := cookieNamed(resp, "yondrive_oidc_flow")
	if flow == nil {
		s.t.Fatalf("no flow cookie: went to %s", resp.Header.Get("Location"))
	}
	at := s.get(resp.Header.Get("Location"))
	if at.StatusCode != http.StatusFound {
		s.t.Fatalf("authorize: %d", at.StatusCode)
	}
	back, err := url.Parse(at.Header.Get("Location"))
	if err != nil {
		s.t.Fatal(err)
	}
	if !strings.HasPrefix(at.Header.Get("Location"), "https://drive.example.com/auth/oidc/callback?") {
		s.t.Fatalf("redirect uri: %s", at.Header.Get("Location"))
	}
	return back.Query(), flow
}

// back is the last hop.
func (s *ssoFixture) back(query url.Values, cookies ...*http.Cookie) hop {
	s.t.Helper()
	return s.get(s.e.ts.URL+"/auth/oidc/callback?"+query.Encode(), cookies...)
}

// failure fails the test unless the sign-in that ended in resp was refused with code.
func (s *ssoFixture) wantFailure(resp hop, code string) {
	s.t.Helper()
	if want := "/signin?sso_error=" + code; resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != want {
		s.t.Errorf("went to %q (%d), want %q", resp.Header.Get("Location"), resp.StatusCode, want)
	}
	if cookieNamed(resp, "yondrive_session") != nil {
		s.t.Error("a refused sign-in has a session")
	}
}

// attempt is a whole sign-in, from the start, and returns the last response.
func (s *ssoFixture) attempt() hop {
	s.t.Helper()
	query, flow := s.leave("")
	return s.back(query, flow)
}

// signIn fails the test unless the sign-in works, and returns the browser's session.
func (s *ssoFixture) signIn() *client {
	s.t.Helper()
	resp := s.attempt()
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/" {
		s.t.Fatalf("sign-in went to %q (%d)", resp.Header.Get("Location"), resp.StatusCode)
	}
	c := cookieNamed(resp, "yondrive_session")
	if c == nil {
		s.t.Fatal("no session cookie")
	}
	return &client{e: s.e, cookie: c.Name + "=" + c.Value}
}

type accountBody struct {
	User struct {
		ID           string `json:"id"`
		Username     string `json:"username"`
		Email        string `json:"email"`
		Role         string `json:"role"`
		SignInMethod string `json:"sign_in_method"`
		QuotaBytes   int64  `json:"quota_bytes"`
	} `json:"user"`
	EnrolmentRequired bool `json:"enrolment_required"`
	Keys              *struct {
		WrappedMasterKey string `json:"wrapped_master_key"`
	} `json:"keys"`
	Kdf struct {
		Salt string `json:"salt"`
	} `json:"kdf"`
}

func me(t *testing.T, c *client) accountBody {
	t.Helper()
	resp := c.call(http.MethodGet, "/api/v1/me", nil)
	resp.wantStatus(t, http.StatusOK)
	var a accountBody
	resp.decode(t, &a)
	return a
}

func enrolBody(tag byte, name string) obj {
	return obj{
		"kdf":               kdf(tag),
		"unlock_auth_key":   b64(key(name + "-unlock")),
		"recovery_auth_key": b64(key(name + "-recovery")),
		"keys":              accountKeys(tag),
	}
}

func TestSignInMakesAnAccountAndASessionWithNoTokenInAnyURL(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		s := newSSO(t, mode, nil)
		s.who("s1", obj{"email": "alice@example.com", "email_verified": true, "preferred_username": "Alice"})
		resp := s.attempt()
		if resp.Header.Get("Location") != "/" {
			t.Fatalf("went to %q", resp.Header.Get("Location"))
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Errorf("cache-control = %q", resp.Header.Get("Cache-Control"))
		}
		session := cookieNamed(resp, "yondrive_session")
		if session == nil || !session.HttpOnly || session.SameSite != http.SameSiteStrictMode {
			t.Fatalf("session cookie = %+v", session)
		}
		if flow := cookieNamed(resp, "yondrive_oidc_flow"); flow == nil || flow.MaxAge >= 0 {
			t.Errorf("the flow cookie was not cleared: %+v", flow)
		}
		a := me(t, &client{e: s.e, cookie: session.Name + "=" + session.Value})
		if a.User.Username != "alice" || a.User.Email != "alice@example.com" || a.User.Role != "user" || a.User.SignInMethod != "sso" || a.User.QuotaBytes != 1000 {
			t.Errorf("account = %+v", a)
		}
		if a.EnrolmentRequired != (mode == "e2e") || a.Keys != nil {
			t.Errorf("enrolment = %v, keys %v", a.EnrolmentRequired, a.Keys)
		}
		// The same person comes back to the same account, and no other is made.
		again := me(t, s.signIn())
		if again.User.ID != a.User.ID {
			t.Errorf("another account: %+v", again)
		}
		if !s.e.audited("sso_login_succeeded") || !s.e.audited("sso_user_created") {
			t.Error("not audited")
		}
	})
}

func TestStartAsksTheProviderWell(t *testing.T) {
	s := newSSO(t, "e2e", obj{"scopes": "openid email groups"})
	resp := s.get(s.e.ts.URL + "/api/v1/auth/oidc/start")
	flow := cookieNamed(resp, "yondrive_oidc_flow")
	if flow == nil || !flow.HttpOnly || flow.SameSite != http.SameSiteLaxMode || flow.Domain != "" || flow.Path != "/" || flow.MaxAge != 600 {
		t.Errorf("flow cookie = %+v", flow)
	}
	q, _ := url.Parse(resp.Header.Get("Location"))
	if q.Query().Get("redirect_uri") != "https://drive.example.com/auth/oidc/callback" || q.Query().Get("scope") != "openid email groups" || q.Query().Get("code_challenge_method") != "S256" || q.Query().Has("prompt") {
		t.Errorf("query = %v", q.Query())
	}
	if strings.Contains(flow.Value, q.Query().Get("state")) {
		t.Error("the flow cookie is readable")
	}
	s.leave("?fresh=true")
	if s.fake.LastAuthorize().Get("prompt") != "login" {
		t.Error("fresh did not ask for a login")
	}
}

func TestFlowCookieOverHTTPSIsHostOnlyByName(t *testing.T) {
	e := configured(t, "none", server.Config{Secure: server.SecureAlways})
	fake := oidctest.New(t)
	fake.Now = e.now
	e.login("root").call(http.MethodPatch, settingsRoute, obj{"oidc": oidcInput(fake, nil), "current_auth_key": ""}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	e.login("root").call(http.MethodPatch, settingsRoute, obj{"oidc": oidcInput(fake, nil), "current_auth_key": b64(key("root"))}).wantStatus(t, http.StatusOK)
	s := &ssoFixture{t: t, e: e, fake: fake}
	resp := s.get(e.ts.URL + "/api/v1/auth/oidc/start")
	flow := cookieNamed(resp, "__Host-yondrive_oidc_flow")
	if flow == nil || !flow.Secure || flow.Domain != "" || flow.Path != "/" {
		t.Fatalf("flow cookie = %+v", flow)
	}
	at := s.get(resp.Header.Get("Location"))
	back, _ := url.Parse(at.Header.Get("Location"))
	if done := s.back(back.Query(), flow); done.Header.Get("Location") != "/" {
		t.Errorf("went to %q", done.Header.Get("Location"))
	}
}

func TestCallbackRefusesWhatIsNotThisBrowsersSignIn(t *testing.T) {
	s := newSSO(t, "e2e", nil)
	s.who("s1", nil)

	t.Run("no cookie", func(t *testing.T) {
		query, _ := s.leave("")
		s.wantFailure(s.back(query), "sso_state_invalid")
	})
	t.Run("another state", func(t *testing.T) {
		query, flow := s.leave("")
		query.Set("state", "another")
		s.wantFailure(s.back(query, flow), "sso_state_invalid")
	})
	t.Run("no state", func(t *testing.T) {
		query, flow := s.leave("")
		query.Del("state")
		s.wantFailure(s.back(query, flow), "sso_state_invalid")
	})
	t.Run("another browser's cookie", func(t *testing.T) {
		query, _ := s.leave("")
		_, other := s.leave("")
		s.wantFailure(s.back(query, other), "sso_state_invalid")
	})
	t.Run("a forged cookie", func(t *testing.T) {
		query, flow := s.leave("")
		forged := &http.Cookie{Name: flow.Name, Value: "AAAA" + flow.Value[4:]} //nolint:gosec // only ever sent, by this test
		s.wantFailure(s.back(query, forged), "sso_state_invalid")
	})
	t.Run("too late", func(t *testing.T) {
		query, flow := s.leave("")
		s.e.advance(11 * time.Minute)
		s.wantFailure(s.back(query, flow), "sso_state_invalid")
	})
	t.Run("an error from the provider", func(t *testing.T) {
		query, flow := s.leave("")
		query.Del("code")
		query.Set("error", "access_denied")
		s.wantFailure(s.back(query, flow), "sso_denied")
	})
	t.Run("an error with no state says nothing", func(t *testing.T) {
		_, flow := s.leave("")
		s.wantFailure(s.back(url.Values{"error": {"access_denied"}}, flow), "sso_state_invalid")
	})
	t.Run("a code used twice", func(t *testing.T) {
		query, flow := s.leave("")
		if resp := s.back(query, flow); resp.Header.Get("Location") != "/" {
			t.Fatalf("went to %q", resp.Header.Get("Location"))
		}
		s.wantFailure(s.back(query, flow), "sso_provider_error")
	})
	if !s.e.audited("sso_login_failed") {
		t.Error("failures are not audited")
	}
}

func TestCallbackRefusesForgedTokens(t *testing.T) {
	for name, forge := range map[string]func(*oidctest.Provider){
		"alg none": func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["alg"] = "none" }
			f.Signer = func(string) []byte { return nil }
		},
		"HS256": func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["alg"] = "HS256" }
		},
		"wrong issuer": func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { c["iss"] = "https://evil.example" }
		},
		"wrong audience": func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { c["aud"] = "another" }
		},
		"bad nonce": func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { c["nonce"] = "another" }
		},
		"expired": func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { c["exp"] = f.Now().Unix() - 3600 }
		},
		"wrong key": func(f *oidctest.Provider) {
			f.Signer = func(string) []byte { return make([]byte, 256) }
		},
	} {
		t.Run(name, func(t *testing.T) {
			s := newSSO(t, "e2e", nil)
			s.who("s1", nil)
			forge(s.fake)
			s.wantFailure(s.attempt(), "sso_token_invalid")
			users, err := s.e.st.ListUsers(ctx)
			if err != nil || len(users) != 1 {
				t.Errorf("users = %v, %v", users, err)
			}
		})
	}
}

func TestProviderFailureComesBackAsACode(t *testing.T) {
	s := newSSO(t, "e2e", nil)
	s.fake.RefuseToken = true
	s.wantFailure(s.attempt(), "sso_provider_error")
	s.fake.RefuseToken = false
	s.fake.Close()
	s.e.advance(2 * time.Hour)
	s.wantFailure(s.get(s.e.ts.URL+"/api/v1/auth/oidc/start"), "sso_provider_error")
}

func TestSignInWhenTurnedOff(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	s := &ssoFixture{t: t, e: e}
	s.wantFailure(s.get(e.ts.URL+"/api/v1/auth/oidc/start"), "sso_disabled")
	s.wantFailure(s.get(e.ts.URL+"/auth/oidc/callback?state=x&code=y"), "sso_disabled")
	e.call(http.MethodPost, "/api/v1/auth/oidc/start", obj{"invite_token": "x"}).wantError(t, http.StatusForbidden, "invite_invalid")
}

func TestLinkingByEmail(t *testing.T) {
	s := newSSO(t, "e2e", nil)
	aliceID := s.registerEmail("alice", "Alice@Example.com", nil)

	t.Run("an unverified address does not link", func(t *testing.T) {
		for _, claims := range []obj{
			{"email": "alice@example.com", "email_verified": false},
			{"email": "alice@example.com"},
			{"email": "alice@example.com", "email_verified": "true"},
		} {
			s.who("attacker", claims)
			s.fake.UserInfo = nil
			s.wantFailure(s.attempt(), "sso_email_unverified")
		}
		if u, _ := s.e.st.UserByID(ctx, aliceID); u.HasIdentity() {
			t.Error("linked")
		}
	})
	t.Run("userinfo cannot verify another address than the token's", func(t *testing.T) {
		s.who("attacker", obj{"email": "alice@example.com", "email_verified": false})
		s.fake.UserInfo = obj{"email": "other@example.com", "email_verified": true}
		s.wantFailure(s.attempt(), "sso_email_unverified")
		s.fake.UserInfo = nil
	})
	t.Run("a verified one does", func(t *testing.T) {
		s.who("s-alice", obj{"email": "alice@example.com", "email_verified": true})
		a := me(t, s.signIn())
		if a.User.ID != aliceID || a.User.SignInMethod != "both" {
			t.Errorf("account = %+v", a)
		}
		if a.Keys == nil {
			t.Error("the local account's keys are gone")
		}
		if !s.e.audited("sso_identity_linked") {
			t.Error("not audited")
		}
	})
	t.Run("another subject is never moved onto it", func(t *testing.T) {
		s.who("s-other", obj{"email": "alice@example.com", "email_verified": true})
		s.wantFailure(s.attempt(), "sso_identity_conflict")
		u, err := s.e.st.UserByIdentity(ctx, s.fake.Issuer(), "s-alice")
		if err != nil || u.ID != aliceID {
			t.Errorf("identity = %+v, %v", u, err)
		}
	})
	t.Run("the local password still works", func(t *testing.T) {
		s.e.login("alice")
	})
	t.Run("a new unverified address is not stored", func(t *testing.T) {
		s.who("s-new", obj{"email": "new@example.com", "preferred_username": "new"})
		if a := me(t, s.signIn()); a.User.Email != "" {
			t.Errorf("email = %q", a.User.Email)
		}
	})
}

// registerEmail makes a local account with an address, through an invite for it.
func (s *ssoFixture) registerEmail(name, email string, invite obj) string {
	s.t.Helper()
	body := obj{"email": email}
	for k, v := range invite {
		body[k] = v
	}
	token := createInvite(s.t, s.root, body)
	resp := s.e.call(http.MethodPost, "/api/v1/auth/register", obj{"invite_token": token, "account": account(name, s.mode)})
	resp.wantStatus(s.t, http.StatusCreated)
	var created struct {
		UserID string `json:"user_id"`
	}
	resp.decode(s.t, &created)
	return created.UserID
}

func TestLinkingByUsernameAndBySubject(t *testing.T) {
	t.Run("preferred_username", func(t *testing.T) {
		s := newSSO(t, "e2e", obj{"match_mode": "preferred_username"})
		aliceID := s.e.register(s.root, "alice", "e2e")
		s.who("s1", obj{"preferred_username": "ALICE"})
		if a := me(t, s.signIn()); a.User.ID != aliceID {
			t.Errorf("account = %+v", a)
		}
		s.who("s2", obj{"preferred_username": "alice"})
		s.wantFailure(s.attempt(), "sso_identity_conflict")
	})
	t.Run("sub links nothing", func(t *testing.T) {
		s := newSSO(t, "e2e", obj{"match_mode": "sub"})
		aliceID := s.registerEmail("alice", "alice@example.com", nil)
		s.who("s1", obj{"preferred_username": "alice", "email": "alice@example.com", "email_verified": true})
		a := me(t, s.signIn())
		if a.User.ID == aliceID || a.User.Username != "alice-2" || a.User.Email != "" {
			t.Errorf("account = %+v", a)
		}
		if u, _ := s.e.st.UserByID(ctx, aliceID); u.HasIdentity() {
			t.Error("the local account was linked")
		}
	})
	t.Run("email mode does not link a name", func(t *testing.T) {
		s := newSSO(t, "e2e", nil)
		aliceID := s.e.register(s.root, "alice", "e2e")
		s.who("s1", obj{"preferred_username": "alice"})
		if a := me(t, s.signIn()); a.User.ID == aliceID {
			t.Error("a name took the account")
		}
	})
}

func TestUsernamesOfNewAccounts(t *testing.T) {
	s := newSSO(t, "e2e", obj{"match_mode": "sub"})
	for _, tc := range []struct {
		claims obj
		want   string
	}{
		{obj{"preferred_username": "Jo Smith!"}, "jo-smith-"},
		{obj{"email": "first.last@example.com"}, "first.last"},
		{obj{"preferred_username": "_-."}, "user"},
		{obj{}, "user-2"},
		{obj{"preferred_username": "root"}, "root-2"},
		{obj{"preferred_username": strings.Repeat("a", 200)}, strings.Repeat("a", 58)},
	} {
		s.who("sub-"+tc.want, tc.claims)
		if a := me(t, s.signIn()); a.User.Username != tc.want {
			t.Errorf("%v: username = %q, want %q", tc.claims, a.User.Username, tc.want)
		}
	}
}

func TestDisabledUserCannotSignIn(t *testing.T) {
	s := newSSO(t, "none", nil)
	s.who("s1", nil)
	a := me(t, s.signIn())
	s.root.call(http.MethodPatch, "/api/v1/admin/users/"+a.User.ID, obj{"disabled": true}).wantStatus(t, http.StatusOK)
	s.wantFailure(s.attempt(), "user_disabled")
	// Nor does a disabled local account get linked.
	id := s.registerEmail("bob", "bob@example.com", nil)
	s.root.call(http.MethodPatch, "/api/v1/admin/users/"+id, obj{"disabled": true}).wantStatus(t, http.StatusOK)
	s.who("s2", obj{"email": "bob@example.com", "email_verified": true})
	s.wantFailure(s.attempt(), "user_disabled")
	if u, _ := s.e.st.UserByID(ctx, id); u.HasIdentity() {
		t.Error("linked")
	}
}

func createInvite(t *testing.T, root *client, body obj) string {
	t.Helper()
	resp := root.call(http.MethodPost, "/api/v1/admin/invites", body)
	resp.wantStatus(t, http.StatusCreated)
	var inv struct {
		Token string `json:"token"`
	}
	resp.decode(t, &inv)
	return inv.Token
}

// startInvited goes through POST start, and returns what the browser comes back with.
func (s *ssoFixture) startInvited(token string) (url.Values, *http.Cookie) {
	s.t.Helper()
	resp := s.e.call(http.MethodPost, "/api/v1/auth/oidc/start", obj{"invite_token": token})
	resp.wantStatus(s.t, http.StatusOK)
	var start struct {
		URL string `json:"authorize_url"`
	}
	resp.decode(s.t, &start)
	flow := cookieNamed(hop{Header: resp.header}, "yondrive_oidc_flow")
	if flow == nil {
		s.t.Fatal("no flow cookie")
	}
	at := s.get(start.URL)
	back, err := url.Parse(at.Header.Get("Location"))
	if err != nil {
		s.t.Fatal(err)
	}
	return back.Query(), flow
}

func TestOnlyIfInvited(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		s := newSSO(t, mode, obj{"new_users": "invited"})

		t.Run("no invite", func(t *testing.T) {
			s.who("s1", obj{"email": "a@example.com", "email_verified": true})
			s.wantFailure(s.attempt(), "sso_not_invited")
		})
		t.Run("an invite for the verified address", func(t *testing.T) {
			createInvite(t, s.root, obj{"email": "invited@example.com", "quota_bytes": 77})
			s.who("s2", obj{"email": "invited@example.com", "email_verified": false})
			s.wantFailure(s.attempt(), "sso_not_invited")
			s.who("s2", obj{"email": "INVITED@example.com", "email_verified": true})
			a := me(t, s.signIn())
			if a.User.QuotaBytes != 77 {
				t.Errorf("quota = %d", a.User.QuotaBytes)
			}
			// It is used now, and the next person needs another.
			s.who("s3", obj{"email": "invited@example.com", "email_verified": true})
			s.wantFailure(s.attempt(), "sso_identity_conflict")
		})
		t.Run("an invite token", func(t *testing.T) {
			token := createInvite(t, s.root, obj{})
			s.who("s4", nil)
			query, flow := s.startInvited(token)
			if resp := s.back(query, flow); resp.Header.Get("Location") != "/" {
				t.Fatalf("went to %q", resp.Header.Get("Location"))
			}
			// Burnt.
			s.e.call(http.MethodPost, "/api/v1/auth/oidc/start", obj{"invite_token": token}).wantError(t, http.StatusForbidden, "invite_invalid")
			s.who("s5", nil)
			query, flow = s.leave("")
			s.wantFailure(s.back(query, flow), "sso_not_invited")
		})
		t.Run("a token used up while signing in", func(t *testing.T) {
			token := createInvite(t, s.root, obj{})
			s.who("s6", nil)
			first, firstFlow := s.startInvited(token)
			second, secondFlow := s.startInvited(token)
			if resp := s.back(first, firstFlow); resp.Header.Get("Location") != "/" {
				t.Fatalf("went to %q", resp.Header.Get("Location"))
			}
			s.who("s7", nil)
			s.wantFailure(s.back(second, secondFlow), "invite_invalid")
		})
		t.Run("a token for someone else's address", func(t *testing.T) {
			token := createInvite(t, s.root, obj{"email": "x@example.com"})
			s.who("s8", obj{"email": "y@example.com", "email_verified": true})
			query, flow := s.startInvited(token)
			s.wantFailure(s.back(query, flow), "invite_invalid")
			// A refused sign-in does not use it up.
			s.who("s9", obj{"email": "x@example.com", "email_verified": true})
			query, flow = s.startInvited(token)
			if resp := s.back(query, flow); resp.Header.Get("Location") != "/" {
				t.Errorf("went to %q", resp.Header.Get("Location"))
			}
		})
		s.e.call(http.MethodPost, "/api/v1/auth/oidc/start", obj{"invite_token": "nope"}).wantError(t, http.StatusForbidden, "invite_invalid")
	})
}

func TestAnInviteGivesItsRoleOnCreate(t *testing.T) {
	s := newSSO(t, "none", nil)
	token := createInvite(t, s.root, obj{"role": "admin", "current_auth_key": b64(key("root"))})
	s.who("s1", nil)
	query, flow := s.startInvited(token)
	resp := s.back(query, flow)
	c := cookieNamed(resp, "yondrive_session")
	if c == nil {
		t.Fatal("no session")
	}
	if a := me(t, &client{e: s.e, cookie: c.Name + "=" + c.Value}); a.User.Role != "admin" {
		t.Errorf("role = %s", a.User.Role)
	}
}

func TestAdminGroup(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		s := newSSO(t, mode, obj{"admin_group": "yd-admins", "admin_claim": "roles"})
		in := obj{"roles": []any{"x", "yd-admins"}}
		out := obj{"roles": []any{"x"}}

		s.who("s1", in)
		c := s.signIn()
		id := me(t, c).User.ID
		if a := me(t, c); a.User.Role != "admin" {
			t.Fatalf("not promoted: %+v", a)
		}
		c.call(http.MethodGet, "/api/v1/admin/users", nil).wantStatus(t, http.StatusOK)

		s.who("s1", out)
		s.signIn()
		// In force at once, even for the session already open.
		c.call(http.MethodGet, "/api/v1/admin/users", nil).wantError(t, http.StatusForbidden, "forbidden")
		if !s.e.audited("sso_role_granted") || !s.e.audited("sso_role_revoked") {
			t.Error("not audited")
		}

		s.who("s1", in)
		s.signIn()
		s.who("s1", obj{})
		s.fake.UserInfo = nil
		s.signIn()
		if u, _ := s.e.st.UserByID(ctx, id); u.Role != "user" {
			t.Errorf("a missing claim kept the role: %s", u.Role)
		}

		s.who("s1", obj{"roles": "yd-admins"})
		s.signIn()
		if u, _ := s.e.st.UserByID(ctx, id); u.Role != "admin" {
			t.Errorf("a single string did not count: %s", u.Role)
		}
	})
}

func TestAdminGroupNeverDemotesTheFallbackAdmin(t *testing.T) {
	s := newSSO(t, "e2e", obj{"admin_group": "yd-admins"})
	rootID := me(t, s.root).User.ID
	s.who("s-root", obj{"email": "root@example.com", "email_verified": true, "groups": []any{}})
	c := s.signIn()
	if a := me(t, c); a.User.ID != rootID || a.User.Role != "admin" {
		t.Errorf("account = %+v", a)
	}
	// A later local admin who is not in the group has no such protection.
	secondID := s.registerEmail("second", "second@example.com", obj{"role": "admin", "current_auth_key": b64(key("root"))})
	s.who("s-second", obj{"email": "second@example.com", "email_verified": true, "groups": []any{}})
	s.signIn()
	if u, _ := s.e.st.UserByID(ctx, secondID); u.Role != "user" {
		t.Errorf("second admin stayed: %s", u.Role)
	}
}

func TestGroupIsIgnoredWhenNotSet(t *testing.T) {
	s := newSSO(t, "none", nil)
	s.who("s1", obj{"groups": []any{"admins", "yd-admins"}})
	if a := me(t, s.signIn()); a.User.Role != "user" {
		t.Errorf("role = %s", a.User.Role)
	}
	s.who("s2", obj{"email": "root@example.com", "email_verified": true})
	if a := me(t, s.signIn()); a.User.Role != "admin" {
		t.Errorf("role = %s", a.User.Role)
	}
}

func TestUserInfoIsOnlyAFallback(t *testing.T) {
	s := newSSO(t, "e2e", obj{"admin_group": "admins"})
	s.who("s1", obj{"email": "a@example.com", "email_verified": true, "preferred_username": "a", "groups": []any{"admins"}})
	s.signIn()
	if n := s.fake.UserInfoCalls(); n != 0 {
		t.Errorf("userinfo was called %d times", n)
	}

	s.who("s2", nil)
	s.fake.UserInfo = obj{"email": "b@example.com", "email_verified": true, "preferred_username": "bee", "groups": []any{"admins"}}
	a := me(t, s.signIn())
	if a.User.Username != "bee" || a.User.Email != "b@example.com" || a.User.Role != "admin" {
		t.Errorf("account = %+v", a)
	}
	if n := s.fake.UserInfoCalls(); n != 1 {
		t.Errorf("userinfo was called %d times", n)
	}

	// It cannot be about someone else.
	s.who("s3", nil)
	s.fake.UserInfo = obj{"sub": "s2"}
	s.wantFailure(s.attempt(), "sso_provider_error")
}

func TestEnrolment(t *testing.T) {
	s := newSSO(t, "e2e", nil)
	s.who("s1", obj{"preferred_username": "sso-user"})
	c := s.signIn()
	path := "/api/v1/auth/oidc/enrol"
	body := enrolBody(20, "sso-user")

	for _, bad := range []obj{
		{"kdf": kdf(20), "unlock_auth_key": b64(fill(1, 5)), "recovery_auth_key": b64(key("r")), "keys": accountKeys(20)},
		{"kdf": kdf(20), "unlock_auth_key": b64(key("u")), "recovery_auth_key": b64(fill(1, 5)), "keys": accountKeys(20)},
	} {
		c.call(http.MethodPost, path, bad).wantError(t, http.StatusBadRequest, "invalid_auth_key")
	}
	weak := enrolBody(20, "sso-user")
	weak["kdf"] = obj{"name": "argon2id", "m": 1, "t": 1, "p": 1, "salt": b64(fill(1, 16))}
	c.call(http.MethodPost, path, weak).wantError(t, http.StatusBadRequest, "invalid_kdf")
	noKeys := enrolBody(20, "sso-user")
	keys := accountKeys(20)
	keys["wrapped_master_key"] = b64(fill(1, 2))
	noKeys["keys"] = keys
	c.call(http.MethodPost, path, noKeys).wantError(t, http.StatusBadRequest, "invalid_keys")
	s.e.call(http.MethodPost, path, body).wantError(t, http.StatusUnauthorized, "unauthorized")

	before := me(t, c)
	resp := c.call(http.MethodPost, path, body)
	resp.wantStatus(t, http.StatusOK)
	var enrolled accountBody
	resp.decode(t, &enrolled)
	if enrolled.Keys == nil || enrolled.EnrolmentRequired || enrolled.Kdf.Salt == before.Kdf.Salt {
		t.Errorf("enrolled = %s", resp.body)
	}
	if !s.e.audited("sso_keys_enrolled") {
		t.Error("not audited")
	}

	// Once. A stolen session must not be able to replace keys.
	c.call(http.MethodPost, path, enrolBody(30, "attacker")).wantError(t, http.StatusConflict, "already_enrolled")
	if a := me(t, c); a.Keys.WrappedMasterKey != enrolled.Keys.WrappedMasterKey {
		t.Error("the keys changed")
	}
	// They come back through the provider on another device.
	if a := me(t, s.signIn()); a.Keys == nil || a.EnrolmentRequired {
		t.Errorf("next sign-in: %+v", a)
	}

	// A local account has keys, and nothing to enrol.
	s.root.call(http.MethodPost, path, enrolBody(30, "root")).wantError(t, http.StatusConflict, "already_enrolled")
	t.Run("a token is not a session", func(t *testing.T) {
		tok := s.root.call(http.MethodPost, "/api/v1/me/tokens", obj{"name": "t", "current_auth_key": b64(key("root"))})
		tok.wantStatus(t, http.StatusCreated)
		var created struct {
			Secret string `json:"secret"`
		}
		tok.decode(t, &created)
		s.e.call(http.MethodPost, path, enrolBody(30, "x"), "Authorization", "Bearer "+created.Secret).wantError(t, http.StatusForbidden, "session_required")
	})
}

func TestEnrolmentInNoEncryptionMode(t *testing.T) {
	s := newSSO(t, "none", nil)
	s.who("s1", nil)
	c := s.signIn()
	if a := me(t, c); a.EnrolmentRequired {
		t.Error("enrolment asked for")
	}
	c.call(http.MethodPost, "/api/v1/auth/oidc/enrol", enrolBody(20, "x")).wantError(t, http.StatusConflict, "wrong_mode")
}

// enrolled signs someone in through the provider and gives them keys.
func (s *ssoFixture) enrolled(name string) (*client, accountBody) {
	s.t.Helper()
	s.who("sub-"+name, obj{"preferred_username": name})
	c := s.signIn()
	c.call(http.MethodPost, "/api/v1/auth/oidc/enrol", enrolBody(20, name)).wantStatus(s.t, http.StatusOK)
	return c, me(s.t, c)
}

func TestSSOAccountsDoNotSignInLocally(t *testing.T) {
	s := newSSO(t, "e2e", nil)
	_, a := s.enrolled("carol")

	// The unlock key is a current credential, and to the sign-in route it is nothing,
	// and the same nothing as for a name that does not exist.
	s.e.loginWith("carol", key("carol-unlock")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	s.e.loginWith("carol", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	s.e.loginWith("nobody", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	// Only the right key learns which way to go.
	s.e.loginWith("carol", key("carol-recovery")).wantError(t, http.StatusForbidden, "sso_required")

	// To a stranger this name looks like no account at all.
	resp := s.e.call(http.MethodGet, "/api/v1/auth/kdf?username=carol", nil)
	resp.wantStatus(t, http.StatusOK)
	var params struct {
		Salt string `json:"salt"`
	}
	resp.decode(t, &params)
	if params.Salt == a.Kdf.Salt {
		t.Error("the kdf route gave out the real salt")
	}
}

func TestCurrentCredentialOfAnSSOAccount(t *testing.T) {
	s := newSSO(t, "e2e", nil)
	c, a := s.enrolled("carol")
	unlock := b64(key("carol-unlock"))
	recovery := b64(key("carol-recovery"))

	t.Run("a session alone is not enough", func(t *testing.T) {
		c.call(http.MethodPost, "/api/v1/me/tokens", obj{"name": "t", "current_auth_key": b64(key("wrong"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
		c.call(http.MethodPost, "/api/v1/auth/rekey", obj{"current_auth_key": b64(key("wrong")), "auth_key": b64(key("new")), "kdf": kdf(5), "wrapped_master_key": b64(fill(5, 72))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	})
	t.Run("either key makes a token", func(t *testing.T) {
		c.call(http.MethodPost, "/api/v1/me/tokens", obj{"name": "a", "current_auth_key": unlock}).wantStatus(t, http.StatusCreated)
		c.call(http.MethodPost, "/api/v1/me/tokens", obj{"name": "b", "current_auth_key": recovery}).wantStatus(t, http.StatusCreated)
	})
	t.Run("TOTP belongs to the provider", func(t *testing.T) {
		c.call(http.MethodPost, "/api/v1/auth/totp/enrol", obj{"current_auth_key": unlock}).wantError(t, http.StatusConflict, "totp_local_only")
		c.call(http.MethodPost, "/api/v1/auth/totp/confirm", obj{"code": "000000"}).wantError(t, http.StatusConflict, "totp_local_only")
	})
	t.Run("recovery with the words, after signing in through the provider", func(t *testing.T) {
		other := s.signIn()
		c.call(http.MethodGet, "/api/v1/me", nil).wantStatus(t, http.StatusOK)
		other.call(http.MethodPost, "/api/v1/auth/rekey", obj{
			"current_auth_key": recovery, "auth_key": b64(key("carol-unlock-2")), "kdf": kdf(6), "wrapped_master_key": b64(fill(6, 72)),
		}).wantStatus(t, http.StatusNoContent)
		// Everything else ended, the rekey's session did not.
		c.call(http.MethodGet, "/api/v1/me", nil).wantError(t, http.StatusUnauthorized, "unauthorized")
		fresh := me(t, other)
		if fresh.Keys.WrappedMasterKey == a.Keys.WrappedMasterKey {
			t.Error("the wrapped key did not change")
		}
		other.call(http.MethodPost, "/api/v1/me/tokens", obj{"name": "c", "current_auth_key": unlock}).wantError(t, http.StatusUnauthorized, "wrong_credential")
		other.call(http.MethodPost, "/api/v1/me/tokens", obj{"name": "c", "current_auth_key": b64(key("carol-unlock-2"))}).wantStatus(t, http.StatusCreated)
		// Rekeying has not given the account a way to sign in locally.
		s.e.loginWith("carol", key("carol-unlock-2")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
		u, err := s.e.st.UserByUsername(ctx, "carol")
		if err != nil || u.AuthKeyHash != nil || u.UnlockAuthKeyHash == nil {
			t.Errorf("hashes = %v %v, %v", u.AuthKeyHash, u.UnlockAuthKeyHash, err)
		}
		other.call(http.MethodPost, "/api/v1/auth/rekey", obj{
			"current_auth_key": recovery, "recovery_auth_key": b64(key("carol-recovery-2")), "wrapped_master_key_recovery": b64(fill(7, 72)),
		}).wantStatus(t, http.StatusNoContent)
		other.call(http.MethodPost, "/api/v1/me/tokens", obj{"name": "d", "current_auth_key": recovery}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	})
	t.Run("before enrolment there is no credential", func(t *testing.T) {
		s.who("sub-new", nil)
		n := s.signIn()
		n.call(http.MethodPost, "/api/v1/me/tokens", obj{"name": "t", "current_auth_key": b64(key("anything"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
		n.call(http.MethodPost, "/api/v1/auth/rekey", obj{"current_auth_key": "", "auth_key": b64(key("x")), "kdf": kdf(5), "wrapped_master_key": b64(fill(5, 72))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	})
}

func TestLinkedLocalAccountKeepsItsPassphrase(t *testing.T) {
	s := newSSO(t, "e2e", nil)
	s.registerEmail("alice", "alice@example.com", nil)
	s.who("s1", obj{"email": "alice@example.com", "email_verified": true})
	c := s.signIn()
	c.call(http.MethodPost, "/api/v1/auth/rekey", obj{
		"current_auth_key": b64(key("alice")), "auth_key": b64(key("alice-2")), "kdf": kdf(5), "wrapped_master_key": b64(fill(5, 72)),
	}).wantStatus(t, http.StatusNoContent)
	s.e.loginKey("alice", key("alice-2"))
	c.call(http.MethodPost, "/api/v1/auth/totp/enrol", obj{"current_auth_key": b64(key("alice-2"))}).wantStatus(t, http.StatusOK)
}

func TestNoEncryptionModeHasARecentSignInForACredential(t *testing.T) {
	s := newSSO(t, "none", nil)
	s.who("s1", nil)
	c := s.signIn()
	token := obj{"name": "t", "current_auth_key": ""}
	c.call(http.MethodPost, "/api/v1/me/tokens", token).wantStatus(t, http.StatusCreated)

	s.e.advance(6 * time.Minute)
	c.call(http.MethodPost, "/api/v1/me/tokens", token).wantError(t, http.StatusUnauthorized, "reauth_required")

	query, flow := s.leave("?fresh=true")
	resp := s.back(query, flow)
	session := cookieNamed(resp, "yondrive_session")
	if session == nil {
		t.Fatal("no session")
	}
	fresh := &client{e: s.e, cookie: session.Name + "=" + session.Value}
	fresh.call(http.MethodPost, "/api/v1/me/tokens", token).wantStatus(t, http.StatusCreated)
	fresh.call(http.MethodPost, "/api/v1/auth/rekey", obj{"current_auth_key": "", "auth_key": b64(key("x")), "kdf": kdf(5)}).wantError(t, http.StatusConflict, "sso_only")
	fresh.call(http.MethodPost, "/api/v1/auth/totp/enrol", obj{"current_auth_key": ""}).wantError(t, http.StatusConflict, "totp_local_only")

	u := me(t, fresh)
	s.root.call(http.MethodPost, "/api/v1/admin/users/"+u.User.ID+"/password-reset", obj{"current_auth_key": b64(key("root"))}).wantError(t, http.StatusConflict, "sso_only")
	s.e.loginWith(u.User.Username, key("anything")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
}

func TestLocalAccountsOff(t *testing.T) {
	s := newSSO(t, "none", nil)
	cur := b64(key("root"))
	s.e.register(s.root, "alice", "none")
	off := obj{"local_accounts": false, "current_auth_key": cur}

	t.Run("not with no way to sign in", func(t *testing.T) {
		s.root.call(http.MethodPatch, settingsRoute, obj{"local_accounts": false}).wantError(t, http.StatusUnauthorized, "wrong_credential")
		s.root.call(http.MethodPatch, settingsRoute, obj{"oidc": obj{"enabled": false}, "current_auth_key": cur}).wantStatus(t, http.StatusOK)
		s.root.call(http.MethodPatch, settingsRoute, off).wantError(t, http.StatusConflict, "local_accounts_lockout")
		s.root.call(http.MethodPatch, settingsRoute, obj{"oidc": obj{"enabled": true}, "current_auth_key": cur}).wantStatus(t, http.StatusOK)
	})
	s.root.call(http.MethodPatch, settingsRoute, off).wantStatus(t, http.StatusOK)

	t.Run("sign-in", func(t *testing.T) {
		s.e.login("root")
		s.e.loginWith("alice", key("alice")).wantError(t, http.StatusForbidden, "local_accounts_disabled")
		s.e.loginWith("alice", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
		s.who("s1", nil)
		s.signIn()
	})
	t.Run("registration", func(t *testing.T) {
		token := createInvite(t, s.root, obj{})
		s.e.call(http.MethodPost, "/api/v1/auth/register", obj{"invite_token": token, "account": account("new", "none")}).wantError(t, http.StatusForbidden, "local_accounts_disabled")
	})
	t.Run("what the page shows", func(t *testing.T) {
		resp := s.e.call(http.MethodGet, "/api/v1/auth/methods", nil)
		resp.wantStatus(t, http.StatusOK)
		var got struct {
			Local bool `json:"local_accounts"`
			OIDC  *struct {
				Label string `json:"label"`
			} `json:"oidc"`
		}
		resp.decode(t, &got)
		if got.Local || got.OIDC == nil || got.OIDC.Label != "Fake ID" {
			t.Errorf("methods = %s", resp.body)
		}
	})
	t.Run("the provider cannot be turned off under it", func(t *testing.T) {
		s.root.call(http.MethodPatch, settingsRoute, obj{"oidc": obj{"enabled": false}, "current_auth_key": cur}).wantError(t, http.StatusConflict, "local_accounts_lockout")
	})
	t.Run("the last local admin cannot be removed", func(t *testing.T) {
		rootID := me(t, s.root).User.ID
		// Another admin, through the provider, who would otherwise be able to.
		invite := createInvite(t, s.root, obj{"role": "admin", "current_auth_key": cur})
		s.who("s-admin", nil)
		query, flow := s.startInvited(invite)
		session := cookieNamed(s.back(query, flow), "yondrive_session")
		if session == nil {
			t.Fatal("no session")
		}
		admin := &client{e: s.e, cookie: session.Name + "=" + session.Value}
		admin.call(http.MethodPatch, "/api/v1/admin/users/"+rootID, obj{"disabled": true}).wantError(t, http.StatusConflict, "local_accounts_lockout")
		admin.call(http.MethodDelete, "/api/v1/admin/users/"+rootID, obj{"current_auth_key": ""}).wantError(t, http.StatusConflict, "local_accounts_lockout")
	})
	t.Run("turned back on", func(t *testing.T) {
		s.root.call(http.MethodPatch, settingsRoute, obj{"local_accounts": true, "current_auth_key": cur}).wantStatus(t, http.StatusOK)
		s.e.login("alice")
	})
}

func TestOIDCSettings(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	root := e.login("root")
	fake := oidctest.New(t)
	cur := b64(key("root"))
	patch := func(o obj) response {
		return root.call(http.MethodPatch, settingsRoute, obj{"oidc": o, "current_auth_key": cur})
	}

	t.Run("a session alone cannot change them", func(t *testing.T) {
		root.call(http.MethodPatch, settingsRoute, obj{"oidc": oidcInput(fake, nil)}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	})
	t.Run("the secret is never read back", func(t *testing.T) {
		resp := patch(oidcInput(fake, nil))
		resp.wantStatus(t, http.StatusOK)
		read := root.call(http.MethodGet, settingsRoute, nil)
		for _, r := range []response{resp, read} {
			if strings.Contains(string(r.body), "the client secret") {
				t.Errorf("secret in %s", r.body)
			}
		}
		var got struct {
			OIDC struct {
				Set      bool   `json:"client_secret_set"`
				Redirect string `json:"redirect_uri"`
			} `json:"oidc"`
		}
		read.decode(t, &got)
		if !got.OIDC.Set || got.OIDC.Redirect != "https://drive.example.com/auth/oidc/callback" {
			t.Errorf("settings = %s", read.body)
		}
		// Leaving it out, or blank, keeps it.
		patch(obj{"label": "Other"}).wantStatus(t, http.StatusOK)
		patch(obj{"client_secret": ""}).wantStatus(t, http.StatusOK)
		st, err := e.st.Settings(ctx)
		if err != nil || st.OIDC.ClientSecret != oidctest.ClientSecret || st.OIDC.Label != "Other" {
			t.Errorf("stored = %+v, %v", st.OIDC, err)
		}
	})
	t.Run("the issuer is https unless allowed", func(t *testing.T) {
		patch(obj{"issuer": "http://id.example.com", "allow_insecure": false}).wantError(t, http.StatusBadRequest, "invalid_issuer")
		patch(obj{"issuer": "http://id.example.com", "allow_insecure": true}).wantStatus(t, http.StatusOK)
		patch(obj{"allow_insecure": false}).wantError(t, http.StatusBadRequest, "invalid_issuer")
		patch(obj{"issuer": "https://id.example.com/", "allow_insecure": false}).wantStatus(t, http.StatusOK)
		st, _ := e.st.Settings(ctx)
		if st.OIDC.Issuer != "https://id.example.com/" {
			t.Errorf("the issuer was changed: %q", st.OIDC.Issuer)
		}
		patch(obj{"issuer": "ftp://x"}).wantError(t, http.StatusBadRequest, "invalid_issuer")
	})
	t.Run("what is not valid", func(t *testing.T) {
		for name, o := range map[string]obj{
			"no openid":      {"scopes": "profile email"},
			"bad scope":      {"scopes": "openid\nemail"},
			"no label":       {"label": " "},
			"match mode":     {"match_mode": "name"},
			"new users":      {"new_users": "anyone"},
			"group, claim":   {"admin_group": "g", "admin_claim": ""},
			"long secret":    {"client_secret": strings.Repeat("s", 2000)},
			"control":        {"client_id": "a\nb"},
			"enabled, no id": {"enabled": true, "client_id": ""},
		} {
			if resp := patch(o); resp.status != http.StatusBadRequest {
				t.Errorf("%s: %d %s", name, resp.status, resp.body)
			}
		}
	})
	t.Run("a user cannot read them", func(t *testing.T) {
		e.register(root, "alice", "e2e")
		e.login("alice").call(http.MethodGet, settingsRoute, nil).wantError(t, http.StatusForbidden, "forbidden")
	})
}

func TestSetupTakesSignInSettings(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e := newEnv(t, server.Config{PublicURL: "https://x.example"})
		fake := oidctest.New(t)
		fake.Now = e.now

		info := e.call(http.MethodGet, "/api/v1/setup/info", nil, "X-Setup-Token", testSetupToken)
		info.wantStatus(t, http.StatusOK)
		var got struct {
			Path string `json:"oidc_redirect_path"`
			URI  string `json:"oidc_redirect_uri"`
		}
		info.decode(t, &got)
		if got.Path != "/auth/oidc/callback" || got.URI != "https://x.example/auth/oidc/callback" {
			t.Errorf("info = %s", info.body)
		}

		body := setupBody(mode)
		body["sign_in"] = obj{"local_accounts": false, "open_signup": true}
		e.call(http.MethodPost, setupPath, body, "X-Setup-Token", testSetupToken).wantError(t, http.StatusConflict, "local_accounts_lockout")
		body["sign_in"] = obj{"oidc": oidcInput(fake, obj{"allow_insecure": false})}
		e.call(http.MethodPost, setupPath, body, "X-Setup-Token", testSetupToken).wantError(t, http.StatusBadRequest, "invalid_issuer")
		if _, err := e.st.Settings(ctx); err == nil {
			t.Fatal("refused setup wrote settings")
		}

		body["sign_in"] = obj{"local_accounts": false, "open_signup": true, "oidc": oidcInput(fake, obj{"match_mode": "sub"})}
		e.call(http.MethodPost, setupPath, body, "X-Setup-Token", testSetupToken).wantStatus(t, http.StatusCreated)
		st, err := e.st.Settings(ctx)
		if err != nil || st.LocalAccounts || !st.OpenSignup || !st.OIDC.Enabled || st.OIDC.ClientSecret != oidctest.ClientSecret || st.OIDC.MatchMode != store.MatchSubject {
			t.Errorf("settings = %+v, %v", st, err)
		}

		// The first admin is local and works, and the provider works too.
		root := e.login("root")
		s := &ssoFixture{t: t, e: e, fake: fake, root: root, mode: mode}
		s.who("s1", nil)
		s.signIn()
	})
}

func TestTestConnection(t *testing.T) {
	path := "/api/v1/oidc/test"
	t.Run("in the wizard", func(t *testing.T) {
		e := newEnv(t, server.Config{})
		fake := oidctest.New(t)
		body := obj{"issuer": fake.Issuer(), "allow_insecure": true}
		e.call(http.MethodPost, path, body).wantError(t, http.StatusUnauthorized, "setup_token_invalid")
		resp := e.call(http.MethodPost, path, body, "X-Setup-Token", testSetupToken)
		resp.wantStatus(t, http.StatusOK)
		var got struct {
			Issuer   string `json:"issuer"`
			Token    string `json:"token_endpoint"`
			UserInfo string `json:"userinfo_endpoint"`
			JWKS     string `json:"jwks_uri"`
			Method   string `json:"token_auth_method"`
			PKCE     bool   `json:"pkce_s256"`
			Keys     int    `json:"keys"`
		}
		resp.decode(t, &got)
		if got.Issuer != fake.Issuer() || got.Token == "" || got.UserInfo == "" || got.JWKS == "" || got.Method != "client_secret_basic" || !got.PKCE || got.Keys != 3 {
			t.Errorf("result = %s", resp.body)
		}
	})
	t.Run("afterwards", func(t *testing.T) {
		e := configured(t, "e2e", server.Config{})
		fake := oidctest.New(t)
		body := obj{"issuer": fake.Issuer(), "allow_insecure": true}
		e.call(http.MethodPost, path, body).wantError(t, http.StatusUnauthorized, "unauthorized")
		e.call(http.MethodPost, path, body, "X-Setup-Token", testSetupToken).wantError(t, http.StatusUnauthorized, "unauthorized")
		root := e.login("root")
		e.register(root, "alice", "e2e")
		e.login("alice").call(http.MethodPost, path, body).wantError(t, http.StatusForbidden, "forbidden")
		root.call(http.MethodPost, path, body).wantStatus(t, http.StatusOK)

		root.call(http.MethodPost, path, obj{"issuer": fake.Issuer()}).wantError(t, http.StatusBadRequest, "invalid_issuer")
		root.call(http.MethodPost, path, obj{"issuer": "not an address"}).wantError(t, http.StatusBadRequest, "invalid_issuer")
		fake.Document = func(d map[string]any) { d["issuer"] = "https://evil.example" }
		root.call(http.MethodPost, path, body).wantError(t, http.StatusBadGateway, "oidc_issuer_mismatch")
		fake.Document = func(d map[string]any) { d["jwks_uri"] = fake.URL + "/none" }
		root.call(http.MethodPost, path, body).wantError(t, http.StatusBadGateway, "oidc_keys_failed")
		fake.Document = nil
		fake.Close()
		root.call(http.MethodPost, path, body).wantError(t, http.StatusBadGateway, "oidc_discovery_failed")
	})
}

func TestUnlink(t *testing.T) {
	s := newSSO(t, "e2e", nil)
	id := s.registerEmail("alice", "alice@example.com", nil)
	s.who("old-sub", obj{"email": "alice@example.com", "email_verified": true})
	c := s.signIn()
	route := "/api/v1/admin/users/" + id + "/identity"
	cur := obj{"current_auth_key": b64(key("root"))}

	s.who("new-sub", obj{"email": "alice@example.com", "email_verified": true})
	s.wantFailure(s.attempt(), "sso_identity_conflict")

	s.root.call(http.MethodDelete, route, obj{"current_auth_key": b64(key("wrong"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	c.call(http.MethodDelete, route, cur).wantError(t, http.StatusForbidden, "forbidden")
	s.root.call(http.MethodDelete, route, cur).wantStatus(t, http.StatusNoContent)
	c.call(http.MethodGet, "/api/v1/me", nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	s.root.call(http.MethodDelete, route, cur).wantError(t, http.StatusNotFound, "not_found")
	if !s.e.audited("sso_identity_unlinked") {
		t.Error("not audited")
	}
	if a := me(t, s.signIn()); a.User.ID != id {
		t.Errorf("did not link again: %+v", a)
	}
	s.root.call(http.MethodDelete, "/api/v1/admin/users/"+me(t, s.root).User.ID+"/identity", cur).wantError(t, http.StatusConflict, "cannot_modify_self")
}

func TestAnUnlinkedSSOAccountStillDoesNotSignInLocally(t *testing.T) {
	s := newSSO(t, "e2e", obj{"match_mode": "preferred_username"})
	_, a := s.enrolled("carol")
	s.root.call(http.MethodDelete, "/api/v1/admin/users/"+a.User.ID+"/identity", obj{"current_auth_key": b64(key("root"))}).wantStatus(t, http.StatusNoContent)
	s.e.loginWith("carol", key("carol-recovery")).wantError(t, http.StatusForbidden, "sso_required")
}

func TestSignInRoutesAreRateLimited(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 1})
	fake := oidctest.New(t)
	fake.Now = e.now
	e.login("root").call(http.MethodPatch, settingsRoute, obj{"oidc": oidcInput(fake, nil), "current_auth_key": b64(key("root"))}).wantError(t, http.StatusTooManyRequests, "rate_limited")
	s := &ssoFixture{t: t, e: e, fake: fake}
	s.wantFailure(s.get(e.ts.URL+"/auth/oidc/callback?state=x"), "rate_limited")
}

func TestHealthCountsSSO(t *testing.T) {
	s := newSSO(t, "none", nil)
	s.who("s1", nil)
	s.signIn()
	resp := s.root.call(http.MethodGet, "/api/v1/admin/health", nil)
	resp.wantStatus(t, http.StatusOK)
	var got struct {
		Enabled bool  `json:"oidc_enabled"`
		Users   int64 `json:"sso_users"`
	}
	resp.decode(t, &got)
	if !got.Enabled || got.Users != 1 {
		t.Errorf("health = %s", resp.body)
	}
}

func TestUnlinkRefusesWhatTheMatchModeCannotFind(t *testing.T) {
	cur := obj{"current_auth_key": b64(key("root"))}
	for name, extra := range map[string]obj{
		"sub mode":       {"match_mode": "sub"},
		"email, no mail": nil,
	} {
		t.Run(name, func(t *testing.T) {
			s := newSSO(t, "e2e", extra)
			_, a := s.enrolled("carol")
			route := "/api/v1/admin/users/" + a.User.ID + "/identity"
			s.root.call(http.MethodDelete, route, cur).wantError(t, http.StatusConflict, "identity_not_relinkable")
			if a2 := me(t, s.signIn()); a2.User.ID != a.User.ID {
				t.Errorf("signed in to another account: %+v", a2)
			}
		})
	}
}
