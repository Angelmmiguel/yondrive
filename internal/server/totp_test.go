package server_test

import (
	"encoding/base32"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/server"
)

const (
	enrolPath   = "/api/v1/auth/totp/enrol"
	confirmPath = "/api/v1/auth/totp/confirm"
	disablePath = "/api/v1/auth/totp/disable"
)

// enrol turns TOTP on for root and returns the secret and recovery codes.
func enrol(t *testing.T, e *env, c *client) ([]byte, []string) {
	t.Helper()
	resp := c.call(http.MethodPost, enrolPath, obj{"current_auth_key": b64(key("root"))})
	resp.wantStatus(t, http.StatusOK)
	var got struct {
		Secret string `json:"secret"`
		URI    string `json:"uri"`
	}
	resp.decode(t, &got)
	if !strings.HasPrefix(got.URI, "otpauth://totp/Home:root?") {
		t.Errorf("uri = %q", got.URI)
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(got.Secret)
	if err != nil || len(secret) != auth.TOTPSecretLen {
		t.Fatalf("secret %q: %v", got.Secret, err)
	}
	resp = c.call(http.MethodPost, confirmPath, obj{"code": auth.TOTPCode(secret, e.now())})
	resp.wantStatus(t, http.StatusOK)
	var codes struct {
		RecoveryCodes []string `json:"recovery_codes"`
	}
	resp.decode(t, &codes)
	if len(codes.RecoveryCodes) != auth.RecoveryCodeCount {
		t.Fatalf("%d recovery codes", len(codes.RecoveryCodes))
	}
	return secret, codes.RecoveryCodes
}

func TestTOTPRoutesNeedASession(t *testing.T) {
	e := configured(t, "none", server.Config{})
	for path, body := range map[string]obj{
		enrolPath:   {"current_auth_key": b64(key("root"))},
		confirmPath: {"code": "000000"},
		disablePath: {"current_auth_key": b64(key("root"))},
	} {
		e.call(http.MethodPost, path, body).wantError(t, http.StatusUnauthorized, "unauthorized")
	}
}

func TestTOTPEnrolmentAndLogin(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	secret, _ := enrol(t, e, c)
	if !e.audited("totp_enrolled") || !e.audited("totp_enabled") {
		t.Error("no audit rows")
	}

	e.loginWith("root", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
	e.loginWith("root", key("root")).wantError(t, http.StatusUnauthorized, "totp_required")
	e.loginWith("root", key("root"), "totp_code", "000000x").wantError(t, http.StatusUnauthorized, "totp_invalid")

	e.advance(time.Minute)
	e.loginKey("root", key("root"), "totp_code", auth.TOTPCode(secret, e.now()))
	// The recovery auth key still needs the second factor.
	e.advance(time.Minute)
	e.loginWith("root", key("root-recovery")).wantError(t, http.StatusUnauthorized, "totp_required")
	e.loginKey("root", key("root-recovery"), "totp_code", auth.TOTPCode(secret, e.now()))

	var me struct {
		User struct {
			TOTP bool `json:"totp_enabled"`
		} `json:"user"`
	}
	c.call(http.MethodGet, mePath, nil).decode(t, &me)
	if !me.User.TOTP {
		t.Error("profile does not report TOTP")
	}
}

func TestTOTPIsNotInForceUntilConfirmed(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	c.call(http.MethodPost, confirmPath, obj{"code": "000000"}).wantError(t, http.StatusConflict, "totp_not_pending")
	c.call(http.MethodPost, enrolPath, obj{"current_auth_key": b64(key("root"))}).wantStatus(t, http.StatusOK)
	e.login("root")
	c.call(http.MethodPost, confirmPath, obj{"code": "000000"}).wantError(t, http.StatusUnauthorized, "totp_invalid")
	e.login("root")
}

func TestTOTPReplayIsRefused(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	secret, _ := enrol(t, e, c)

	// The code that confirmed enrolment is already burnt.
	code := auth.TOTPCode(secret, e.now())
	e.loginWith("root", key("root"), "totp_code", code).wantError(t, http.StatusUnauthorized, "totp_invalid")

	e.advance(30 * time.Second)
	code = auth.TOTPCode(secret, e.now())
	e.loginKey("root", key("root"), "totp_code", code)
	e.loginWith("root", key("root"), "totp_code", code).wantError(t, http.StatusUnauthorized, "totp_invalid")
	// Neither is an earlier code still in the window.
	earlier := auth.TOTPCode(secret, e.now().Add(-30*time.Second))
	e.loginWith("root", key("root"), "totp_code", earlier).wantError(t, http.StatusUnauthorized, "totp_invalid")
	if !e.audited("totp_failed") {
		t.Error("no audit row")
	}
}

func TestConcurrentUseOfACodeHasOneWinner(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	secret, _ := enrol(t, e, c)
	e.advance(time.Minute)
	code := auth.TOTPCode(secret, e.now())

	var wg sync.WaitGroup
	statuses := make([]int, 4)
	for i := range statuses {
		wg.Go(func() { statuses[i] = e.loginWith("root", key("root"), "totp_code", code).status })
	}
	wg.Wait()
	ok := 0
	for _, s := range statuses {
		if s == http.StatusOK {
			ok++
		}
	}
	if ok != 1 {
		t.Errorf("statuses = %v", statuses)
	}
}

func TestRecoveryCodesAreOneTime(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	_, codes := enrol(t, e, c)
	e.loginKey("root", key("root"), "totp_recovery_code", strings.ToLower(codes[0]))
	e.loginWith("root", key("root"), "totp_recovery_code", codes[0]).wantError(t, http.StatusUnauthorized, "totp_invalid")
	e.loginWith("root", key("root"), "totp_recovery_code", "AAAAAAAA-BBBBBBBB").wantError(t, http.StatusUnauthorized, "totp_invalid")
	if !e.audited("totp_recovery_code_used") {
		t.Error("no audit row")
	}
	u, _ := e.st.UserByUsername(ctx, "root")
	if n, _ := e.st.CountRecoveryCodes(ctx, u.ID); n != auth.RecoveryCodeCount-1 {
		t.Errorf("%d codes left", n)
	}
}

func TestRecoveryCodesAreStoredHashed(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	_, codes := enrol(t, e, c)
	u, _ := e.st.UserByUsername(ctx, "root")
	if ok, err := e.st.ConsumeRecoveryCode(ctx, u.ID, []byte(codes[0])); err != nil || ok {
		t.Errorf("the code itself is in the table: %v, %v", ok, err)
	}
}

func TestSecondFactorGuessesAreLimitedPerUser(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	secret, _ := enrol(t, e, c)
	e.advance(time.Minute)
	for range 5 {
		e.loginWith("root", key("root"), "totp_code", "000000").wantError(t, http.StatusUnauthorized, "totp_invalid")
	}
	e.advance(10 * time.Second)
	e.loginWith("root", key("root"), "totp_code", auth.TOTPCode(secret, e.now())).wantError(t, http.StatusTooManyRequests, "rate_limited")
	e.advance(time.Minute)
	e.loginKey("root", key("root"), "totp_code", auth.TOTPCode(secret, e.now()))
}

func TestEnrolAndDisableNeedTheAuthKey(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	c.call(http.MethodPost, enrolPath, obj{"current_auth_key": b64(key("wrong"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	c.call(http.MethodPost, disablePath, obj{"current_auth_key": b64(key("root"))}).wantError(t, http.StatusConflict, "totp_not_enabled")

	secret, _ := enrol(t, e, c)
	c.call(http.MethodPost, enrolPath, obj{"current_auth_key": b64(key("root"))}).wantError(t, http.StatusConflict, "totp_already_enabled")
	c.call(http.MethodPost, confirmPath, obj{"code": "000000"}).wantError(t, http.StatusConflict, "totp_already_enabled")

	e.advance(time.Minute)
	code := auth.TOTPCode(secret, e.now())
	c.call(http.MethodPost, disablePath, obj{"current_auth_key": b64(key("wrong")), "code": code}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	c.call(http.MethodPost, disablePath, obj{"current_auth_key": b64(key("root"))}).wantError(t, http.StatusUnauthorized, "totp_invalid")
	e.loginWith("root", key("root")).wantError(t, http.StatusUnauthorized, "totp_required")

	c.call(http.MethodPost, disablePath, obj{"current_auth_key": b64(key("root")), "code": code}).wantStatus(t, http.StatusNoContent)
	e.login("root")
	if !e.audited("totp_disabled") {
		t.Error("no audit row")
	}
	u, _ := e.st.UserByUsername(ctx, "root")
	if n, _ := e.st.CountRecoveryCodes(ctx, u.ID); n != 0 || u.TOTPSecret != nil {
		t.Errorf("left behind: %d codes, %x", n, u.TOTPSecret)
	}
}

func TestDisableWithARecoveryCode(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	_, codes := enrol(t, e, c)
	c.call(http.MethodPost, disablePath, obj{"current_auth_key": b64(key("root")), "recovery_code": codes[1]}).wantStatus(t, http.StatusNoContent)
	e.login("root")
}
