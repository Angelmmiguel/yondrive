package server_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const (
	usersPath    = "/api/v1/admin/users"
	settingsPath = "/api/v1/admin/settings"
	resetPath    = "/api/v1/auth/password-reset"
)

func rootKey() obj { return obj{"current_auth_key": b64(key("root"))} }

func TestAdminRoutesNeedAnAdmin(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "none")
	alice := e.login("alice")
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, usersPath, nil},
		{http.MethodPatch, usersPath + "/" + id, obj{"disabled": true}},
		{http.MethodDelete, usersPath + "/" + id, rootKey()},
		{http.MethodPost, usersPath + "/" + id + "/password-reset", rootKey()},
		{http.MethodGet, settingsPath, nil},
		{http.MethodPatch, settingsPath, obj{"name": "x"}},
	} {
		e.call(tc.method, tc.path, tc.body).wantError(t, http.StatusUnauthorized, "unauthorized")
		alice.call(tc.method, tc.path, tc.body).wantError(t, http.StatusForbidden, "forbidden")
	}
}

func TestListUsersHasNoBlobs(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	root := e.login("root")
	e.register(root, "alice", "e2e")
	resp := root.call(http.MethodGet, usersPath, nil)
	resp.wantStatus(t, http.StatusOK)
	var got []struct {
		Username string `json:"username"`
	}
	resp.decode(t, &got)
	if len(got) != 2 || got[0].Username != "alice" || got[1].Username != "root" {
		t.Errorf("users = %s", resp.body)
	}
	for _, leak := range []string{"wrapped", "sealed", "hash", "kdf", "secret"} {
		if strings.Contains(string(resp.body), leak) {
			t.Errorf("%q in %s", leak, resp.body)
		}
	}
}

func TestDisabledUsers(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "e2e")
	alice := e.login("alice")
	alice.call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}).wantStatus(t, http.StatusNoContent)
	resp := alice.call(http.MethodPost, tokensPath, obj{"name": "phone", "current_auth_key": b64(key("alice"))})
	resp.wantStatus(t, http.StatusCreated)
	var created struct {
		Secret string `json:"secret"`
	}
	resp.decode(t, &created)

	resp = root.call(http.MethodPatch, usersPath+"/"+id, obj{"disabled": true})
	resp.wantStatus(t, http.StatusOK)
	var got struct {
		Disabled bool `json:"disabled"`
	}
	resp.decode(t, &got)
	if !got.Disabled {
		t.Errorf("profile = %s", resp.body)
	}
	if !e.audited("user_disabled") {
		t.Error("no audit row")
	}

	alice.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodGet, mePath, nil, bearer(created.Secret)...).wantError(t, http.StatusUnauthorized, "unauthorized")
	if n := e.srv.SessionKeyCount(); n != 0 {
		t.Errorf("%d keys survive", n)
	}
	// The right key learns the account is disabled; a wrong one learns nothing.
	e.loginWith("alice", key("alice")).wantError(t, http.StatusForbidden, "user_disabled")
	e.loginWith("alice", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")

	root.call(http.MethodPatch, usersPath+"/"+id, obj{"disabled": false}).wantStatus(t, http.StatusOK)
	e.login("alice")
	if !e.audited("user_enabled") {
		t.Error("no audit row")
	}
	// Access ended by disabling does not come back.
	alice.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
}

func TestSetQuota(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "none")
	resp := root.call(http.MethodPatch, usersPath+"/"+id, obj{"quota_bytes": 5})
	resp.wantStatus(t, http.StatusOK)
	if u, _ := e.st.UserByID(ctx, id); u.QuotaBytes != 5 {
		t.Errorf("quota = %d", u.QuotaBytes)
	}
	root.call(http.MethodPatch, usersPath+"/"+id, obj{"quota_bytes": -1}).wantError(t, http.StatusBadRequest, "invalid_quota")
	root.call(http.MethodPatch, usersPath+"/nope", obj{"quota_bytes": 1}).wantError(t, http.StatusNotFound, "not_found")
	root.call(http.MethodPatch, usersPath+"/nope", obj{"disabled": true}).wantError(t, http.StatusNotFound, "not_found")
	root.call(http.MethodPatch, usersPath+"/nope", obj{}).wantError(t, http.StatusNotFound, "not_found")
	if !e.audited("quota_set") {
		t.Error("no audit row")
	}
}

func TestAnAdminCannotRemoveThemselves(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	u, _ := e.st.UserByUsername(ctx, "root")
	root.call(http.MethodPatch, usersPath+"/"+u.ID, obj{"disabled": true}).wantError(t, http.StatusConflict, "cannot_modify_self")
	root.call(http.MethodDelete, usersPath+"/"+u.ID, rootKey()).wantError(t, http.StatusConflict, "cannot_modify_self")
	root.call(http.MethodPatch, usersPath+"/"+u.ID, obj{"quota_bytes": 1}).wantStatus(t, http.StatusOK)
}

func TestTwoAdminsCannotDisableEachOther(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	resp := root.call(http.MethodPost, invitesPath, obj{"role": "admin", "current_auth_key": b64(key("root"))})
	var inv struct {
		Token string `json:"token"`
	}
	resp.decode(t, &inv)
	e.call(http.MethodPost, registerPath, obj{"invite_token": inv.Token, "account": account("second", "none")}).wantStatus(t, http.StatusCreated)
	second := e.login("second")
	rootUser, _ := e.st.UserByUsername(ctx, "root")
	secondUser, _ := e.st.UserByUsername(ctx, "second")

	var wg sync.WaitGroup
	wg.Go(func() { root.call(http.MethodPatch, usersPath+"/"+secondUser.ID, obj{"disabled": true}) })
	wg.Go(func() { second.call(http.MethodPatch, usersPath+"/"+rootUser.ID, obj{"disabled": true}) })
	wg.Wait()

	a, _ := e.st.UserByID(ctx, rootUser.ID)
	b, _ := e.st.UserByID(ctx, secondUser.ID)
	if a.Disabled && b.Disabled {
		t.Error("both admins are disabled")
	}
}

func TestDeleteUser(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "none")
	alice := e.login("alice")
	alice.call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}).wantStatus(t, http.StatusNoContent)
	root.call(http.MethodDelete, usersPath+"/"+id, rootKey()).wantStatus(t, http.StatusNoContent)
	alice.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	if n := e.srv.SessionKeyCount(); n != 0 {
		t.Errorf("%d keys survive", n)
	}
	if _, err := e.st.UserByID(ctx, id); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("user survives: %v", err)
	}
	root.call(http.MethodDelete, usersPath+"/"+id, rootKey()).wantError(t, http.StatusNotFound, "not_found")
	if !e.audited("user_deleted") {
		t.Error("no audit row")
	}
	// The name is free again, with new credentials.
	e.register(root, "alice", "none")
}

func TestPasswordReset(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "none")
	alice := e.login("alice")
	alice.call(http.MethodPut, sessionKey, obj{"key": b64(fill(1, 32))}).wantStatus(t, http.StatusNoContent)

	root.call(http.MethodPost, usersPath+"/nope/password-reset", rootKey()).wantError(t, http.StatusNotFound, "not_found")
	resp := root.call(http.MethodPost, usersPath+"/"+id+"/password-reset", rootKey())
	resp.wantStatus(t, http.StatusCreated)
	var issued struct {
		Token     string    `json:"token"`
		Link      string    `json:"link"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	resp.decode(t, &issued)
	if issued.Link != "https://drive.example.com/reset#"+issued.Token || !issued.ExpiresAt.Equal(e.now().Add(24*time.Hour)) {
		t.Errorf("issued = %s", resp.body)
	}
	if !e.audited("password_reset_issued") {
		t.Error("no audit row")
	}

	body := func(token string, authKey []byte) obj {
		return obj{"token": token, "auth_key": b64(authKey), "kdf": kdf(5)}
	}
	e.call(http.MethodPost, resetPath, body("made-up", key("new"))).wantError(t, http.StatusForbidden, "reset_invalid")
	e.call(http.MethodPost, resetPath, body(issued.Token, fill(1, 4))).wantError(t, http.StatusBadRequest, "invalid_auth_key")
	bad := body(issued.Token, key("new"))
	bad["kdf"] = obj{"name": "argon2id", "m": 1, "t": 1, "p": 1, "salt": b64(fill(1, 16))}
	e.call(http.MethodPost, resetPath, bad).wantError(t, http.StatusBadRequest, "invalid_kdf")
	e.login("alice")

	e.call(http.MethodPost, resetPath, body(issued.Token, key("new"))).wantStatus(t, http.StatusNoContent)
	e.loginWith("alice", key("alice")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	e.loginKey("alice", key("new"))
	alice.call(http.MethodGet, mePath, nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	if n := e.srv.SessionKeyCount(); n != 0 {
		t.Errorf("%d keys survive", n)
	}
	if !e.audited("password_reset_completed") {
		t.Error("no audit row")
	}

	// One-time.
	e.call(http.MethodPost, resetPath, body(issued.Token, key("again"))).wantError(t, http.StatusForbidden, "reset_invalid")
}

func TestPasswordResetNeedsTheAdminsAuthKey(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "none")
	path := usersPath + "/" + id + "/password-reset"

	resp := root.call(http.MethodPost, path, rootKey())
	resp.wantStatus(t, http.StatusCreated)
	var issued struct {
		Token string `json:"token"`
	}
	resp.decode(t, &issued)

	root.call(http.MethodPost, path, nil).wantError(t, http.StatusBadRequest, "bad_request")
	root.call(http.MethodPost, path, obj{}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	root.call(http.MethodPost, path, obj{"current_auth_key": b64(key("alice"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	if !e.audited("credential_rejected") {
		t.Error("no audit row")
	}
	// A refused call leaves the earlier link in force.
	e.call(http.MethodPost, resetPath, obj{"token": issued.Token, "auth_key": b64(key("new")), "kdf": kdf(5)}).wantStatus(t, http.StatusNoContent)

	tokenResp := root.call(http.MethodPost, tokensPath, obj{"name": "phone", "current_auth_key": b64(key("root"))})
	tokenResp.wantStatus(t, http.StatusCreated)
	var created struct {
		Secret string `json:"secret"`
	}
	tokenResp.decode(t, &created)
	e.call(http.MethodPost, path, obj{}, bearer(created.Secret)...).wantError(t, http.StatusUnauthorized, "wrong_credential")
	e.call(http.MethodPost, path, rootKey(), bearer(created.Secret)...).wantStatus(t, http.StatusCreated)
}

func TestPasswordResetExpires(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "none")
	resp := root.call(http.MethodPost, usersPath+"/"+id+"/password-reset", rootKey())
	var issued struct {
		Token string `json:"token"`
	}
	resp.decode(t, &issued)
	e.advance(24 * time.Hour)
	e.call(http.MethodPost, resetPath, obj{"token": issued.Token, "auth_key": b64(key("new")), "kdf": kdf(5)}).wantError(t, http.StatusForbidden, "reset_invalid")
}

func TestPasswordResetIsRefusedInE2EMode(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "e2e")
	root.call(http.MethodPost, usersPath+"/"+id+"/password-reset", rootKey()).wantError(t, http.StatusConflict, "wrong_mode")
	e.call(http.MethodPost, resetPath, obj{"token": "x", "auth_key": b64(key("new")), "kdf": kdf(5)}).wantError(t, http.StatusConflict, "wrong_mode")
	// Even with a row planted in the table, the route will not use it.
	if err := e.st.CreatePasswordReset(ctx, auth.HashToken("planted"), id, e.now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	e.call(http.MethodPost, resetPath, obj{"token": "planted", "auth_key": b64(key("new")), "kdf": kdf(5)}).wantError(t, http.StatusConflict, "wrong_mode")
	e.login("alice")
}

func TestPasswordResetIsRateLimited(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 1})
	e.call(http.MethodPost, resetPath, obj{"token": "x", "auth_key": b64(key("n")), "kdf": kdf(5)}).wantError(t, http.StatusForbidden, "reset_invalid")
	e.call(http.MethodPost, resetPath, obj{"token": "x", "auth_key": b64(key("n")), "kdf": kdf(5)}).wantError(t, http.StatusTooManyRequests, "rate_limited")
}

func TestSettingsRoutes(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	root := e.login("root")
	resp := root.call(http.MethodGet, settingsPath, nil)
	resp.wantStatus(t, http.StatusOK)
	var got, want any
	resp.decode(t, &got)
	data, _ := json.Marshal(obj{
		"name": "Home", "public_url": "https://drive.example.com", "default_quota_bytes": 1000,
		"language": "en", "time_zone": "Europe/Madrid", "mode": "e2e", "open_signup": false, "proxy_untrusted": false,
		"purge_grace_days": 30, "trash_retention_days": 30, "audit_retention_days": 365, "journal_retention_days": 90, "local_accounts": true,
		"oidc": obj{
			"enabled": false, "label": "Single sign-on", "issuer": "", "client_id": "", "client_secret_set": false,
			"scopes": "openid profile email", "admin_group": "", "admin_claim": "groups", "match_mode": "email",
			"new_users": "create", "allow_insecure": false, "redirect_uri": "https://drive.example.com/auth/oidc/callback",
		},
	})
	_ = json.Unmarshal(data, &want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("settings = %s", resp.body)
	}

	resp = root.call(http.MethodPatch, settingsPath, obj{
		"name": "Office", "public_url": "http://10.0.0.1:8080/", "default_quota_bytes": 5,
		"language": "pt-BR", "time_zone": "UTC", "open_signup": true,
	})
	resp.wantStatus(t, http.StatusOK)
	var after struct {
		Name       string `json:"name"`
		PublicURL  string `json:"public_url"`
		Quota      int64  `json:"default_quota_bytes"`
		Language   string `json:"language"`
		TimeZone   string `json:"time_zone"`
		OpenSignup bool   `json:"open_signup"`
	}
	resp.decode(t, &after)
	if after.Name != "Office" || after.PublicURL != "http://10.0.0.1:8080" || after.Quota != 5 || after.Language != "pt-BR" || after.TimeZone != "UTC" || !after.OpenSignup {
		t.Errorf("settings = %s", resp.body)
	}
	if !e.audited("settings_changed") {
		t.Error("no audit row")
	}

	for _, bad := range []struct {
		body obj
		code string
	}{
		{obj{"name": ""}, "invalid_settings"},
		{obj{"default_quota_bytes": -1}, "invalid_settings"},
		{obj{"language": "!"}, "invalid_settings"},
		{obj{"time_zone": "../x"}, "invalid_settings"},
		{obj{"public_url": "ftp://x"}, "invalid_public_url"},
	} {
		root.call(http.MethodPatch, settingsPath, bad.body).wantError(t, http.StatusBadRequest, bad.code)
	}
}

func TestSettingsWarnAboutAnUntrustedProxy(t *testing.T) {
	check := func(t *testing.T, e *env, want bool, header ...string) {
		t.Helper()
		c := e.login("root")
		var got struct {
			ProxyUntrusted bool `json:"proxy_untrusted"`
		}
		// The session was made over plain HTTP; a trusted proxy's https makes the
		// server read the __Host- name, so the browser would hold both.
		cookie := c.cookie + "; __Host-" + c.cookie
		resp := e.call(http.MethodGet, settingsPath, nil, append([]string{"Cookie", cookie}, header...)...)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &got)
		if got.ProxyUntrusted != want {
			t.Errorf("headers %v: proxy_untrusted = %v", header, got.ProxyUntrusted)
		}
	}
	e := configured(t, "none", server.Config{})
	check(t, e, false)
	check(t, e, true, "X-Forwarded-For", "1.1.1.1")
	check(t, e, true, "X-Forwarded-Proto", "https")
	check(t, e, true, "Forwarded", "for=1.1.1.1")

	trusted := configured(t, "none", server.Config{TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}})
	check(t, trusted, false, "X-Forwarded-For", "1.1.1.1", "X-Forwarded-Proto", "https")

	c := e.login("root")
	resp := e.call(http.MethodPatch, settingsPath, obj{"name": "x"}, "Cookie", c.cookie, "X-Forwarded-For", "1.1.1.1")
	resp.wantStatus(t, http.StatusOK)
	if !strings.Contains(string(resp.body), `"proxy_untrusted":true`) {
		t.Errorf("patch = %s", resp.body)
	}
}

func TestTheModeCannotChange(t *testing.T) {
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) {
			other := map[string]string{"e2e": "none", "none": "e2e"}[mode]
			e := configured(t, mode, server.Config{})
			root := e.login("root")
			root.call(http.MethodPatch, settingsPath, obj{"mode": other, "name": "New"}).wantStatus(t, http.StatusOK)
			e.call(http.MethodPost, setupPath, setupBody(other), "X-Setup-Token", testSetupToken).wantError(t, http.StatusConflict, "already_setup")

			settings, err := e.st.Settings(ctx)
			if err != nil || settings.Mode != mode || settings.Name != "New" {
				t.Errorf("settings = %+v, %v", settings, err)
			}
			if !strings.Contains(string(e.call(http.MethodGet, "/api/v1/health", nil).body), `"mode":"`+mode+`"`) {
				t.Error("health reports another mode")
			}
		})
	}
}

func TestOpenSignup(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	body := obj{"account": account("alice", "none")}
	e.call(http.MethodPost, registerPath, body).wantError(t, http.StatusForbidden, "signup_closed")
	root.call(http.MethodPatch, settingsPath, obj{"open_signup": true}).wantStatus(t, http.StatusOK)
	e.call(http.MethodPost, registerPath, body).wantStatus(t, http.StatusCreated)
	u, err := e.st.UserByUsername(ctx, "alice")
	if err != nil || u.Role != "user" || u.QuotaBytes != 1000 {
		t.Errorf("user = %+v, %v", u, err)
	}
	e.call(http.MethodPost, registerPath, body).wantError(t, http.StatusConflict, "username_taken")
}

func TestAdminHealthReportsTheBuild(t *testing.T) {
	bundle := strings.Repeat("cd", 32)
	e := configured(t, "none", server.Config{Version: "1.0.0", Commit: "c0ffee", WebBundle: bundle})
	resp := e.login("root").call(http.MethodGet, api+"/admin/health", nil)
	resp.wantStatus(t, http.StatusOK)
	var h struct {
		Version   string `json:"version"`
		Commit    string `json:"commit"`
		WebBundle string `json:"web_bundle"`
	}
	resp.decode(t, &h)
	if h.Version != "1.0.0" || h.Commit != "c0ffee" || h.WebBundle != bundle {
		t.Errorf("health = %+v", h)
	}
}
