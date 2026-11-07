package server_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/server"
)

const tokensPath = "/api/v1/me/tokens" //nolint:gosec // a route, not a credential

// mint creates a device token for root and returns its id and secret.
func mint(t *testing.T, c *client, name string) (string, string) {
	t.Helper()
	resp := c.call(http.MethodPost, tokensPath, obj{"name": name, "current_auth_key": b64(key("root"))})
	resp.wantStatus(t, http.StatusCreated)
	var got struct {
		Secret string `json:"secret"`
		Token  struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"token"`
	}
	resp.decode(t, &got)
	if got.Token.Name != name || got.Secret == "" {
		t.Errorf("created = %s", resp.body)
	}
	return got.Token.ID, got.Secret
}

func bearer(secret string) []string { return []string{"Authorization", "Bearer " + secret} }

func TestTokenRoutesNeedAuth(t *testing.T) {
	e := configured(t, "none", server.Config{})
	e.call(http.MethodGet, tokensPath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodPost, tokensPath, obj{"name": "x", "current_auth_key": b64(key("root"))}).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodDelete, tokensPath+"/x", nil).wantError(t, http.StatusUnauthorized, "unauthorized")
}

func TestBearerTokenAuthenticates(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	_, secret := mint(t, c, "phone")
	if !e.audited("token_created") {
		t.Error("no audit row")
	}
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantStatus(t, http.StatusOK)
	e.call(http.MethodGet, invitesPath, nil, bearer(secret)...).wantStatus(t, http.StatusOK)
	e.call(http.MethodGet, mePath, nil, "Authorization", "bearer "+secret).wantStatus(t, http.StatusOK)

	for _, bad := range []string{"Bearer nope", "Bearer ", "Basic " + secret, secret} {
		e.call(http.MethodGet, mePath, nil, "Authorization", bad).wantError(t, http.StatusUnauthorized, "unauthorized")
	}
}

func TestBearerTokenIsNotStoredInTheClear(t *testing.T) {
	e := configured(t, "none", server.Config{})
	_, secret := mint(t, e.login("root"), "phone")
	if _, err := e.st.TokenByHash(ctx, []byte(secret)); err == nil {
		t.Error("the secret is a key of the table")
	}
	if _, err := e.st.TokenByHash(ctx, auth.HashToken(secret)); err != nil {
		t.Errorf("no token under the hash: %v", err)
	}
}

func TestCreatingATokenNeedsTheAuthKey(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	c.call(http.MethodPost, tokensPath, obj{"name": "x", "current_auth_key": b64(key("wrong"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	c.call(http.MethodPost, tokensPath, obj{"name": "", "current_auth_key": b64(key("root"))}).wantError(t, http.StatusBadRequest, "invalid_token_name")
	c.call(http.MethodPost, tokensPath, obj{"name": strings.Repeat("x", 129), "current_auth_key": b64(key("root"))}).wantError(t, http.StatusBadRequest, "invalid_token_name")
}

func TestBearerRequestsSkipTheSameOriginCheck(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	_, secret := mint(t, c, "phone")
	foreign := []string{"Sec-Fetch-Site", "cross-site", "Origin", "https://elsewhere.example"}

	e.call(http.MethodPost, tokensPath, obj{"name": "tablet", "current_auth_key": b64(key("root"))},
		append(bearer(secret), foreign...)...).wantStatus(t, http.StatusCreated)
	// The same request on a cookie is refused.
	e.call(http.MethodPost, tokensPath, obj{"name": "tablet", "current_auth_key": b64(key("root"))},
		append([]string{"Cookie", c.cookie}, foreign...)...).wantError(t, http.StatusForbidden, "forbidden")
}

// A cross-site request that sets a bad Authorization header must not get to act
// on the victim's cookie: skipping the check commits it to the bearer path.
func TestAForgedBearerHeaderDoesNotBorrowTheCookie(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	e.call(http.MethodPost, logoutPath, nil, "Cookie", c.cookie, "Authorization", "Bearer forged", "Sec-Fetch-Site", "cross-site").
		wantError(t, http.StatusUnauthorized, "unauthorized")
	c.call(http.MethodGet, mePath, nil).wantStatus(t, http.StatusOK)
}

func TestListAndRevokeTokens(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	if resp := c.call(http.MethodGet, tokensPath, nil); strings.TrimSpace(string(resp.body)) != "[]" {
		t.Errorf("empty list = %s", resp.body)
	}
	id, secret := mint(t, c, "phone")
	_, other := mint(t, c, "tablet")

	e.advance(time.Hour)
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantStatus(t, http.StatusOK)

	list := c.call(http.MethodGet, tokensPath, nil)
	list.wantStatus(t, http.StatusOK)
	var got []struct {
		ID         string     `json:"id"`
		Name       string     `json:"name"`
		LastUsedAt *time.Time `json:"last_used_at"`
	}
	list.decode(t, &got)
	if len(got) != 2 || strings.Contains(string(list.body), secret) {
		t.Fatalf("list = %s", list.body)
	}
	for _, tok := range got {
		used := tok.LastUsedAt != nil
		if used != (tok.ID == id) || (used && !tok.LastUsedAt.Equal(e.now())) {
			t.Errorf("token = %+v", tok)
		}
	}

	c.call(http.MethodDelete, tokensPath+"/"+id, nil).wantStatus(t, http.StatusNoContent)
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodGet, mePath, nil, bearer(other)...).wantStatus(t, http.StatusOK)
	c.call(http.MethodDelete, tokensPath+"/"+id, nil).wantError(t, http.StatusNotFound, "not_found")
	if !e.audited("token_revoked") {
		t.Error("no audit row")
	}
}

func TestAUserCannotRevokeAnothersToken(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	e.register(root, "alice", "none")
	id, secret := mint(t, root, "phone")
	e.login("alice").call(http.MethodDelete, tokensPath+"/"+id, nil).wantError(t, http.StatusNotFound, "not_found")
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantStatus(t, http.StatusOK)
}

func TestBearerLogoutRevokesItself(t *testing.T) {
	e := configured(t, "none", server.Config{})
	_, secret := mint(t, e.login("root"), "phone")
	resp := e.call(http.MethodPost, logoutPath, nil, bearer(secret)...)
	resp.wantStatus(t, http.StatusNoContent)
	if resp.header.Get("Set-Cookie") != "" {
		t.Errorf("cookie = %q", resp.header.Get("Set-Cookie"))
	}
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantError(t, http.StatusUnauthorized, "unauthorized")
}

func TestSessionKeyRoutesRefuseBearerTokens(t *testing.T) {
	e := configured(t, "none", server.Config{})
	_, secret := mint(t, e.login("root"), "phone")
	e.call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}, bearer(secret)...).wantError(t, http.StatusForbidden, "session_required")
	e.call(http.MethodGet, sessionKey, nil, bearer(secret)...).wantError(t, http.StatusForbidden, "session_required")
	e.call(http.MethodDelete, sessionKey, nil, bearer(secret)...).wantError(t, http.StatusForbidden, "session_required")
}

func TestRekeyEndsOtherTokensAndKeepsTheOneInUse(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	_, inUse := mint(t, c, "phone")
	_, other := mint(t, c, "tablet")

	e.call(http.MethodPost, rekeyPath, passphraseRekey("root", "new"), bearer(inUse)...).wantStatus(t, http.StatusNoContent)
	e.call(http.MethodGet, mePath, nil, bearer(inUse)...).wantStatus(t, http.StatusOK)
	e.call(http.MethodGet, mePath, nil, bearer(other)...).wantError(t, http.StatusUnauthorized, "unauthorized")
	c.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
}

func TestATokenAloneCannotRekey(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	_, secret := mint(t, e.login("root"), "phone")
	e.call(http.MethodPost, rekeyPath, passphraseRekey("wrong", "new"), bearer(secret)...).wantError(t, http.StatusUnauthorized, "wrong_credential")
}
