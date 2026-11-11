package server_test

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const (
	pairingsPath    = "/api/v1/me/pairings"
	devicePairPath  = "/api/v1/pairings/"
	deviceLoginPath = "/api/v1/auth/device-login"
)

// devicePublicKey is the ephemeral X25519 key a phone draws to claim a code.
func devicePublicKey(t *testing.T) []byte {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k.PublicKey().Bytes()
}

type pairingBody struct {
	ID        string    `json:"id"`
	Status    string    `json:"status"`
	ExpiresAt time.Time `json:"expires_at"`
	Device    *struct {
		Name      string `json:"name"`
		Platform  string `json:"platform"`
		PublicKey []byte `json:"public_key"`
	} `json:"device"`
	Token *tokenBody `json:"token"`
}

type tokenBody struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Platform   string     `json:"platform"`
	Origin     string     `json:"origin"`
	Current    bool       `json:"current"`
	LastUsedAt *time.Time `json:"last_used_at"`
}

type pickupBody struct {
	Status        string    `json:"status"`
	ExpiresAt     time.Time `json:"expires_at"`
	SealedPayload []byte    `json:"sealed_payload"`
}

// startPairing opens a pairing as the given credentials, and returns its id.
func startPairing(t *testing.T, e *env, header ...string) string {
	t.Helper()
	resp := e.call(http.MethodPost, pairingsPath, obj{"current_auth_key": b64(key("root"))}, header...)
	resp.wantStatus(t, http.StatusCreated)
	var p pairingBody
	resp.decode(t, &p)
	if p.Status != "open" || p.Device != nil || !p.ExpiresAt.Equal(e.now().Add(5*time.Minute)) {
		t.Errorf("started = %s", resp.body)
	}
	return p.ID
}

func claimPairing(e *env, id string, publicKey []byte, name, platform string) response {
	body := obj{"public_key": b64(publicKey), "name": name}
	if platform != "" {
		body["platform"] = platform
	}
	return e.call(http.MethodPost, devicePairPath+id+"/claim", body)
}

// secretAndHash is a token secret as a browser draws it, and its hash.
func secretAndHash() (string, []byte) {
	secret := base64.RawURLEncoding.EncodeToString(fill(0x5a, 32)) + "-" + store.NewID()
	return secret, auth.HashToken(secret)
}

func confirmBody(hash, sealed []byte) obj {
	return obj{"token_hash": b64(hash), "sealed_payload": b64(sealed)}
}

// pairDevice runs a pairing to the end for root's session c, and returns the
// device's token secret.
func pairDevice(t *testing.T, c *client, name string) (string, string) {
	t.Helper()
	id := startPairing(t, c.e, "Cookie", c.cookie)
	claimPairing(c.e, id, devicePublicKey(t), name, "ios").wantStatus(t, http.StatusOK)
	secret, hash := secretAndHash()
	c.call(http.MethodPost, pairingsPath+"/"+id+"/confirm", confirmBody(hash, fill(9, 100))).wantStatus(t, http.StatusOK)
	return id, secret
}

func listTokens(t *testing.T, e *env, header ...string) []tokenBody {
	t.Helper()
	resp := e.call(http.MethodGet, tokensPath, nil, header...)
	resp.wantStatus(t, http.StatusOK)
	var out []tokenBody
	resp.decode(t, &out)
	return out
}

func TestPairingADevice(t *testing.T) {
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) {
			e := configured(t, mode, server.Config{})
			c := e.login("root")
			id := startPairing(t, e, "Cookie", c.cookie)

			poll := e.call(http.MethodGet, devicePairPath+id, nil)
			poll.wantStatus(t, http.StatusOK)
			var pickup pickupBody
			poll.decode(t, &pickup)
			if pickup.Status != "open" || pickup.SealedPayload != nil {
				t.Errorf("poll before a claim = %s", poll.body)
			}

			device := devicePublicKey(t)
			resp := claimPairing(e, id, device, "Angel's phone", "ios")
			resp.wantStatus(t, http.StatusOK)
			resp.decode(t, &pickup)
			if pickup.Status != "claimed" {
				t.Errorf("claim = %s", resp.body)
			}

			resp = c.call(http.MethodGet, pairingsPath+"/"+id, nil)
			resp.wantStatus(t, http.StatusOK)
			var p pairingBody
			resp.decode(t, &p)
			if p.Status != "claimed" || p.Device == nil || p.Device.Name != "Angel's phone" || p.Device.Platform != "ios" ||
				!bytes.Equal(p.Device.PublicKey, device) || p.Token != nil {
				t.Fatalf("claimed = %s", resp.body)
			}

			// The browser draws the secret and sends its hash; the server never has it.
			secret, hash := secretAndHash()
			sealed := fill(0x42, 300)
			resp = c.call(http.MethodPost, pairingsPath+"/"+id+"/confirm", confirmBody(hash, sealed))
			resp.wantStatus(t, http.StatusOK)
			if strings.Contains(string(resp.body), secret) {
				t.Error("the answer holds the secret")
			}
			var tok tokenBody
			resp.decode(t, &tok)
			if tok.Origin != "pairing" || tok.Platform != "ios" || tok.Name != "Angel's phone" || tok.Current {
				t.Errorf("token = %s", resp.body)
			}

			poll = e.call(http.MethodGet, devicePairPath+id, nil)
			poll.wantStatus(t, http.StatusOK)
			poll.decode(t, &pickup)
			if pickup.Status != "confirmed" || !bytes.Equal(pickup.SealedPayload, sealed) ||
				!pickup.ExpiresAt.Equal(e.now().Add(2*time.Minute)) {
				t.Errorf("pickup = %s", poll.body)
			}
			resp = c.call(http.MethodGet, pairingsPath+"/"+id, nil)
			resp.decode(t, &p)
			if p.Status != "confirmed" || p.Token == nil || p.Token.ID != tok.ID {
				t.Errorf("confirmed = %s", resp.body)
			}

			e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantStatus(t, http.StatusOK)
			var seen bool
			for _, listed := range listTokens(t, e, bearer(secret)...) {
				if listed.ID == tok.ID {
					seen = listed.Current && listed.Origin == "pairing" && listed.Platform == "ios" && listed.LastUsedAt != nil
				}
			}
			if !seen {
				t.Error("the device does not see itself as current")
			}
			for _, action := range []string{"pairing_started", "pairing_claimed", "pairing_confirmed", "token_created"} {
				if !e.audited(action) {
					t.Errorf("no %s in the audit trail", action)
				}
			}
		})
	}
}

func TestStartingAPairingNeedsACurrentCredential(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	c.call(http.MethodPost, pairingsPath, obj{"current_auth_key": b64(key("wrong"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	e.call(http.MethodPost, pairingsPath, obj{"current_auth_key": b64(key("root"))}).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodGet, pairingsPath+"/"+store.NewID(), nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodPost, pairingsPath+"/"+store.NewID()+"/confirm", obj{}).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodDelete, pairingsPath+"/"+store.NewID(), nil).wantError(t, http.StatusUnauthorized, "unauthorized")
}

func TestStartingAPairingWithoutAPassphraseNeedsAFreshSignIn(t *testing.T) {
	s := newSSO(t, "none", nil)
	s.who("s1", nil)
	c := s.signIn()
	c.call(http.MethodPost, pairingsPath, obj{"current_auth_key": ""}).wantError(t, http.StatusUnauthorized, "reauth_required")
	query, flow := s.leave("?fresh=true")
	session := cookieNamed(s.back(query, flow), "yondrive_session")
	if session == nil {
		t.Fatal("no session")
	}
	fresh := &client{e: s.e, cookie: session.Name + "=" + session.Value}
	fresh.call(http.MethodPost, pairingsPath, obj{"current_auth_key": ""}).wantStatus(t, http.StatusCreated)
}

func TestANewPairingReplacesTheLast(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	first := startPairing(t, e, "Cookie", c.cookie)
	second := startPairing(t, e, "Cookie", c.cookie)
	c.call(http.MethodGet, pairingsPath+"/"+first, nil).wantError(t, http.StatusNotFound, "not_found")
	claimPairing(e, first, devicePublicKey(t), "phone", "").wantError(t, http.StatusNotFound, "pairing_invalid")
	c.call(http.MethodGet, pairingsPath+"/"+second, nil).wantStatus(t, http.StatusOK)
}

func TestOnlyThePairingsOwnSessionSeesIt(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	root := e.login("root")
	other := e.login("root")
	e.register(root, "alice", "e2e")
	alice := e.login("alice")
	id := startPairing(t, e, "Cookie", root.cookie)
	claimPairing(e, id, devicePublicKey(t), "phone", "").wantStatus(t, http.StatusOK)
	_, secret := mint(t, root, "laptop")
	_, hash := secretAndHash()

	for _, header := range [][]string{{"Cookie", other.cookie}, {"Cookie", alice.cookie}, bearer(secret)} {
		e.call(http.MethodGet, pairingsPath+"/"+id, nil, header...).wantError(t, http.StatusNotFound, "not_found")
		e.call(http.MethodPost, pairingsPath+"/"+id+"/confirm", confirmBody(hash, fill(1, 64)), header...).wantError(t, http.StatusNotFound, "not_found")
		e.call(http.MethodDelete, pairingsPath+"/"+id, nil, header...).wantError(t, http.StatusNotFound, "not_found")
	}
	root.call(http.MethodGet, pairingsPath+"/not-an-id", nil).wantError(t, http.StatusBadRequest, "invalid_id")

	// A pairing a token started is the token's, and not the session's.
	byToken := startPairing(t, e, bearer(secret)...)
	e.call(http.MethodGet, pairingsPath+"/"+byToken, nil, bearer(secret)...).wantStatus(t, http.StatusOK)
	root.call(http.MethodGet, pairingsPath+"/"+byToken, nil).wantError(t, http.StatusNotFound, "not_found")
}

func TestClaimingACode(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	id := startPairing(t, e, "Cookie", c.cookie)
	device := devicePublicKey(t)

	claimPairing(e, id, fill(1, 31), "phone", "").wantError(t, http.StatusBadRequest, "invalid_pairing")
	claimPairing(e, id, fill(1, 33), "phone", "").wantError(t, http.StatusBadRequest, "invalid_pairing")
	claimPairing(e, id, fill(0, 32), "phone", "").wantError(t, http.StatusBadRequest, "invalid_pairing")
	claimPairing(e, id, device, "", "").wantError(t, http.StatusBadRequest, "invalid_token_name")
	claimPairing(e, id, device, strings.Repeat("x", 129), "").wantError(t, http.StatusBadRequest, "invalid_token_name")
	claimPairing(e, id, device, "phone", "toaster").wantError(t, http.StatusBadRequest, "invalid_platform")
	claimPairing(e, store.NewID(), device, "phone", "").wantError(t, http.StatusNotFound, "pairing_invalid")
	claimPairing(e, "not-an-id", device, "phone", "").wantError(t, http.StatusNotFound, "pairing_invalid")
	e.call(http.MethodGet, devicePairPath+"not-an-id", nil).wantError(t, http.StatusNotFound, "pairing_invalid")
	e.call(http.MethodGet, devicePairPath+store.NewID(), nil).wantError(t, http.StatusNotFound, "pairing_invalid")

	claimPairing(e, id, device, "phone", "android").wantStatus(t, http.StatusOK)
	claimPairing(e, id, devicePublicKey(t), "thief", "").wantError(t, http.StatusConflict, "pairing_claimed")
	claimPairing(e, id, device, "phone", "android").wantError(t, http.StatusConflict, "pairing_claimed")
}

func TestConfirmingACode(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	id := startPairing(t, e, "Cookie", c.cookie)
	confirm := pairingsPath + "/" + id + "/confirm"
	_, hash := secretAndHash()

	c.call(http.MethodPost, confirm, confirmBody(hash, fill(1, 64))).wantError(t, http.StatusConflict, "pairing_not_claimed")
	claimPairing(e, id, devicePublicKey(t), "phone", "").wantStatus(t, http.StatusOK)
	c.call(http.MethodPost, confirm, confirmBody(hash[:31], fill(1, 64))).wantError(t, http.StatusBadRequest, "invalid_pairing")
	c.call(http.MethodPost, confirm, confirmBody(hash, fill(1, 40))).wantError(t, http.StatusBadRequest, "invalid_pairing")
	c.call(http.MethodPost, confirm, confirmBody(hash, fill(1, 2049))).wantError(t, http.StatusBadRequest, "invalid_pairing")

	// A hash that is already a token's is refused, and no second token appears.
	_, inUse := mint(t, c, "laptop")
	c.call(http.MethodPost, confirm, confirmBody(auth.HashToken(inUse), fill(1, 64))).wantError(t, http.StatusBadRequest, "invalid_pairing")
	if n := len(listTokens(t, e, "Cookie", c.cookie)); n != 1 {
		t.Errorf("%d tokens", n)
	}

	c.call(http.MethodPost, confirm, confirmBody(hash, fill(1, 2048))).wantStatus(t, http.StatusOK)
	_, other := secretAndHash()
	c.call(http.MethodPost, confirm, confirmBody(other, fill(1, 64))).wantError(t, http.StatusConflict, "pairing_already_confirmed")
}

func TestAPairingExpires(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	id := startPairing(t, e, "Cookie", c.cookie)
	claimPairing(e, id, devicePublicKey(t), "phone", "").wantStatus(t, http.StatusOK)
	e.advance(5 * time.Minute)

	_, hash := secretAndHash()
	c.call(http.MethodGet, pairingsPath+"/"+id, nil).wantError(t, http.StatusGone, "pairing_expired")
	c.call(http.MethodPost, pairingsPath+"/"+id+"/confirm", confirmBody(hash, fill(1, 64))).wantError(t, http.StatusGone, "pairing_expired")
	e.call(http.MethodGet, devicePairPath+id, nil).wantError(t, http.StatusNotFound, "pairing_invalid")

	unclaimed := startPairing(t, e, "Cookie", c.cookie)
	e.advance(5 * time.Minute)
	claimPairing(e, unclaimed, devicePublicKey(t), "phone", "").wantError(t, http.StatusNotFound, "pairing_invalid")
}

func TestTheDeviceHasTwoMinutesToCollect(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	id, secret := pairDevice(t, c, "phone")
	e.advance(2*time.Minute - time.Second)
	e.call(http.MethodGet, devicePairPath+id, nil).wantStatus(t, http.StatusOK)
	e.advance(time.Second)
	e.call(http.MethodGet, devicePairPath+id, nil).wantError(t, http.StatusNotFound, "pairing_invalid")

	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := e.st.PairingByID(ctx, id); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("the sweep left the pairing: %v", err)
	}
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantStatus(t, http.StatusOK)
}

func TestCancellingAPairing(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	id := startPairing(t, e, "Cookie", c.cookie)
	c.call(http.MethodDelete, pairingsPath+"/"+id, nil).wantStatus(t, http.StatusNoContent)
	claimPairing(e, id, devicePublicKey(t), "phone", "").wantError(t, http.StatusNotFound, "pairing_invalid")
	c.call(http.MethodDelete, pairingsPath+"/"+id, nil).wantError(t, http.StatusNotFound, "not_found")

	// Cancelled after the confirmation, the token goes too.
	id, secret := pairDevice(t, c, "phone")
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantStatus(t, http.StatusOK)
	c.call(http.MethodDelete, pairingsPath+"/"+id, nil).wantStatus(t, http.StatusNoContent)
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodGet, devicePairPath+id, nil).wantError(t, http.StatusNotFound, "pairing_invalid")
	for _, action := range []string{"pairing_cancelled", "token_revoked"} {
		if !e.audited(action) {
			t.Errorf("no %s in the audit trail", action)
		}
	}
}

func TestSigningOutEndsAnUnconfirmedPairing(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	id := startPairing(t, e, "Cookie", c.cookie)
	claimPairing(e, id, devicePublicKey(t), "phone", "").wantStatus(t, http.StatusOK)
	c.call(http.MethodPost, logoutPath, nil).wantStatus(t, http.StatusNoContent)
	e.call(http.MethodGet, devicePairPath+id, nil).wantError(t, http.StatusNotFound, "pairing_invalid")
}

// confirmPairingFor runs a pairing up to the browser's confirmation, without the
// device collecting anything, and returns its id and the token's secret.
func confirmPairingFor(t *testing.T, c *client) (string, string) {
	t.Helper()
	id := startPairing(t, c.e, "Cookie", c.cookie)
	claimPairing(c.e, id, devicePublicKey(t), "phone", "ios").wantStatus(t, http.StatusOK)
	secret, hash := secretAndHash()
	c.call(http.MethodPost, pairingsPath+"/"+id+"/confirm", confirmBody(hash, fill(9, 100))).wantStatus(t, http.StatusOK)
	return id, secret
}

func TestAConfirmedPairingOutlivesTheBrowserSession(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	id, secret := confirmPairingFor(t, c)
	c.call(http.MethodPost, logoutPath, nil).wantStatus(t, http.StatusNoContent)

	resp := e.call(http.MethodGet, devicePairPath+id, nil)
	resp.wantStatus(t, http.StatusOK)
	var pickup pickupBody
	resp.decode(t, &pickup)
	if pickup.Status != "confirmed" || !bytes.Equal(pickup.SealedPayload, fill(9, 100)) {
		t.Errorf("pickup = %s", resp.body)
	}
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantStatus(t, http.StatusOK)
	// Nobody signed in can reach it any more.
	e.login("root").call(http.MethodGet, pairingsPath+"/"+id, nil).wantError(t, http.StatusNotFound, "not_found")
}

func TestATokenNobodyCollectedIsSweptWithItsPairing(t *testing.T) {
	e := configured(t, "none", server.Config{})
	c := e.login("root")
	_, lost := confirmPairingFor(t, c)
	collected, kept := confirmPairingFor(t, c)
	e.call(http.MethodGet, devicePairPath+collected, nil).wantStatus(t, http.StatusOK)

	e.advance(2 * time.Minute)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	e.call(http.MethodGet, mePath, nil, bearer(lost)...).wantError(t, http.StatusUnauthorized, "unauthorized")
	e.call(http.MethodGet, mePath, nil, bearer(kept)...).wantStatus(t, http.StatusOK)
	if n := len(listTokens(t, e, "Cookie", c.cookie)); n != 1 {
		t.Errorf("%d tokens after the sweep", n)
	}
}

func TestAPairedDeviceIsSignedOutByARekey(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	_, secret := pairDevice(t, c, "phone")
	c.call(http.MethodPost, rekeyPath, passphraseRekey("root", "new")).wantStatus(t, http.StatusNoContent)
	e.call(http.MethodGet, mePath, nil, bearer(secret)...).wantError(t, http.StatusUnauthorized, "unauthorized")
}

func TestClaimsAndPollsAreRateLimited(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 10})
	id := store.NewID()
	for range 60 {
		e.call(http.MethodGet, devicePairPath+id, nil).wantError(t, http.StatusNotFound, "pairing_invalid")
		claimPairing(e, id, fill(1, 32), "phone", "").wantError(t, http.StatusNotFound, "pairing_invalid")
	}
	e.call(http.MethodGet, devicePairPath+id, nil).wantError(t, http.StatusTooManyRequests, "rate_limited")
	claimPairing(e, id, fill(1, 32), "phone", "").wantError(t, http.StatusTooManyRequests, "rate_limited")
	e.advance(time.Minute)
	e.call(http.MethodGet, devicePairPath+id, nil).wantError(t, http.StatusNotFound, "pairing_invalid")
}

func TestAUserHasAtMost24Devices(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	c := e.login("root")
	// A pairing started with room, confirmed once the room is gone.
	id := startPairing(t, e, "Cookie", c.cookie)
	claimPairing(e, id, devicePublicKey(t), "phone", "").wantStatus(t, http.StatusOK)
	for i := range 24 {
		mint(t, c, "device "+string(rune('a'+i)))
	}
	device := obj{"name": "phone", "platform": "ios"}
	c.call(http.MethodPost, tokensPath, obj{"name": "x", "current_auth_key": b64(key("root"))}).wantError(t, http.StatusConflict, "device_limit_reached")
	c.call(http.MethodPost, pairingsPath, obj{"current_auth_key": b64(key("root"))}).wantError(t, http.StatusConflict, "device_limit_reached")
	_, hash := secretAndHash()
	c.call(http.MethodPost, pairingsPath+"/"+id+"/confirm", confirmBody(hash, fill(1, 64))).wantError(t, http.StatusConflict, "device_limit_reached")
	e.call(http.MethodPost, deviceLoginPath, obj{"username": "root", "auth_key": b64(key("root")), "device": device}).
		wantError(t, http.StatusConflict, "device_limit_reached")
}

func deviceLogin(e *env, username string, authKey []byte, extra ...any) response {
	body := obj{"username": username, "auth_key": b64(authKey), "device": obj{"name": "Angel's phone", "platform": "ios"}}
	for i := 0; i+1 < len(extra); i += 2 {
		body[extra[i].(string)] = extra[i+1]
	}
	return e.call(http.MethodPost, deviceLoginPath, body)
}

func TestSigningInOnADevice(t *testing.T) {
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) {
			e := configured(t, mode, server.Config{})
			resp := deviceLogin(e, "root", key("root"))
			resp.wantStatus(t, http.StatusCreated)
			if resp.header.Get("Set-Cookie") != "" {
				t.Errorf("cookie = %q", resp.header.Get("Set-Cookie"))
			}
			var got struct {
				Account struct {
					User struct {
						Username string `json:"username"`
					} `json:"user"`
					Mode string          `json:"mode"`
					Keys *map[string]any `json:"keys"`
				} `json:"account"`
				Token  tokenBody `json:"token"`
				Secret string    `json:"secret"`
			}
			resp.decode(t, &got)
			if got.Account.User.Username != "root" || got.Account.Mode != mode || (got.Account.Keys != nil) != (mode == "e2e") ||
				got.Token.Origin != "login" || got.Token.Platform != "ios" || !got.Token.Current || got.Secret == "" {
				t.Errorf("signed in = %s", resp.body)
			}
			e.call(http.MethodGet, mePath, nil, bearer(got.Secret)...).wantStatus(t, http.StatusOK)
			if _, err := e.st.TokenByHash(ctx, auth.HashToken(got.Secret)); err != nil {
				t.Errorf("no token under the hash: %v", err)
			}
			for _, action := range []string{"login_succeeded", "token_created"} {
				if !e.audited(action) {
					t.Errorf("no %s in the audit trail", action)
				}
			}

			if mode == "e2e" {
				deviceLogin(e, "root", key("root-recovery")).wantStatus(t, http.StatusCreated)
			}
			deviceLogin(e, "root", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
			deviceLogin(e, "nobody", key("wrong")).wantError(t, http.StatusUnauthorized, "invalid_credentials")
			e.call(http.MethodPost, deviceLoginPath, obj{"username": "root", "auth_key": b64(key("root")), "device": obj{"name": ""}}).
				wantError(t, http.StatusBadRequest, "invalid_token_name")
			e.call(http.MethodPost, deviceLoginPath, obj{"username": "root", "auth_key": b64(key("root")), "device": obj{"name": "x", "platform": "toaster"}}).
				wantError(t, http.StatusBadRequest, "invalid_platform")
		})
	}
}

func TestDeviceSignInAsksForTheSecondFactor(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	secret, codes := enrol(t, e, e.login("root"))
	deviceLogin(e, "root", key("root")).wantError(t, http.StatusUnauthorized, "totp_required")
	deviceLogin(e, "root", key("root"), "totp_code", "000000x").wantError(t, http.StatusUnauthorized, "totp_invalid")
	e.advance(time.Minute)
	deviceLogin(e, "root", key("root"), "totp_code", auth.TOTPCode(secret, e.now())).wantStatus(t, http.StatusCreated)
	deviceLogin(e, "root", key("root"), "totp_recovery_code", codes[0]).wantStatus(t, http.StatusCreated)
	deviceLogin(e, "root", key("root"), "totp_recovery_code", codes[0]).wantError(t, http.StatusUnauthorized, "totp_invalid")
}

func TestDeviceSignInIsRefusedToDisabledUsers(t *testing.T) {
	e := configured(t, "none", server.Config{})
	root := e.login("root")
	id := e.register(root, "alice", "none")
	root.call(http.MethodPatch, "/api/v1/admin/users/"+id, obj{"disabled": true}).wantStatus(t, http.StatusOK)
	deviceLogin(e, "alice", key("alice")).wantError(t, http.StatusForbidden, "user_disabled")
}

func TestDeviceSignInFollowsTheSignInSettings(t *testing.T) {
	s := newSSO(t, "none", nil)
	s.e.register(s.root, "alice", "none")
	s.who("s1", nil)
	sso := me(t, s.signIn())
	deviceLogin(s.e, sso.User.Username, key("anything")).wantError(t, http.StatusUnauthorized, "invalid_credentials")

	s.root.call(http.MethodPatch, settingsRoute, obj{"local_accounts": false, "current_auth_key": b64(key("root"))}).wantStatus(t, http.StatusOK)
	deviceLogin(s.e, "alice", key("alice")).wantError(t, http.StatusForbidden, "local_accounts_disabled")
	deviceLogin(s.e, "root", key("root")).wantStatus(t, http.StatusCreated)
}

func TestDeviceSignInIsRateLimited(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 2})
	deviceLogin(e, "root", key("wrong")).wantStatus(t, http.StatusUnauthorized)
	deviceLogin(e, "root", key("wrong")).wantStatus(t, http.StatusUnauthorized)
	deviceLogin(e, "root", key("root")).wantError(t, http.StatusTooManyRequests, "rate_limited")
}
