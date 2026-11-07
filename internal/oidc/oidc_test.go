package oidc

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/oidc/oidctest"
)

var ctx = context.Background()

const testNonce = "the-nonce"

// clock is a settable time for a provider and the client looking at it.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newFake(t *testing.T) (*oidctest.Provider, *Provider, *clock) {
	t.Helper()
	fake := oidctest.New(t)
	c := &clock{t: time.Unix(1_800_000_000, 0)}
	fake.Now = c.now
	p, err := Discover(ctx, NewHTTPClient(nil), fake.Issuer(), true, c.now)
	if err != nil {
		t.Fatal(err)
	}
	return fake, p, c
}

func TestDiscovery(t *testing.T) {
	fake, p, _ := newFake(t)
	m := p.Metadata()
	if m.Issuer != fake.Issuer() || m.TokenEndpoint != fake.URL+"/token" || p.TokenAuthMethod() != authBasic {
		t.Errorf("metadata = %+v, method %s", m, p.TokenAuthMethod())
	}
}

func TestDiscoveryRefuses(t *testing.T) {
	for _, tc := range []struct {
		name     string
		document func(map[string]any)
		want     error
	}{
		{"another issuer", func(d map[string]any) { d["issuer"] = "https://evil.example" }, ErrIssuerMismatch},
		{"a trailing slash of difference", func(d map[string]any) { d["issuer"] = d["issuer"].(string) + "/" }, ErrIssuerMismatch},
		{"no token endpoint", func(d map[string]any) { delete(d, "token_endpoint") }, ErrDiscovery},
		{"no jwks", func(d map[string]any) { delete(d, "jwks_uri") }, ErrDiscovery},
		{"no code flow", func(d map[string]any) { d["response_types_supported"] = []string{"id_token"} }, ErrDiscovery},
		{"no S256", func(d map[string]any) { d["code_challenge_methods_supported"] = []string{"plain"} }, ErrDiscovery},
		{"no secret method", func(d map[string]any) { d["token_endpoint_auth_methods_supported"] = []string{"private_key_jwt"} }, ErrDiscovery},
		{"a non-web endpoint", func(d map[string]any) { d["token_endpoint"] = "file:///etc/passwd" }, ErrDiscovery},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := oidctest.New(t)
			fake.Document = tc.document
			if _, err := Discover(ctx, NewHTTPClient(nil), fake.Issuer(), true, time.Now); !errors.Is(err, tc.want) {
				t.Errorf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestPlainEndpointNeedsAllowInsecureToo(t *testing.T) {
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		issuer := "https://" + r.Host
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": issuer, "authorization_endpoint": issuer + "/a",
			"token_endpoint": "http://" + r.Host + "/t", "jwks_uri": issuer + "/k",
		})
	}))
	defer ts.Close()
	roots := x509.NewCertPool()
	roots.AddCert(ts.Certificate())
	_, err := Discover(ctx, NewHTTPClient(roots), ts.URL, false, time.Now)
	if !errors.Is(err, ErrDiscovery) {
		t.Errorf("err = %v", err)
	}
}

func TestCheckIssuer(t *testing.T) {
	for issuer, allowed := range map[string]bool{
		"https://id.example.com":                          true,
		"https://authentik.example.com/application/o/yd/": true,
		"http://id.example.com":                           false,
		"https://":                                        false,
		"ftp://id.example.com":                            false,
		"https://u:p@id.example.com":                      false,
		"https://id.example.com?x=1":                      false,
		"https://id.example.com#x":                        false,
		"id.example.com":                                  false,
	} {
		if err := CheckIssuer(issuer, false); (err == nil) != allowed {
			t.Errorf("%s: %v", issuer, err)
		}
	}
	if err := CheckIssuer("http://id.lan", true); err != nil {
		t.Errorf("allow insecure: %v", err)
	}
	if _, err := Discover(ctx, NewHTTPClient(nil), "http://id.lan", false, time.Now); !errors.Is(err, ErrInvalidIssuer) {
		t.Errorf("discover over http: %v", err)
	}
}

func TestHTTPClientBounds(t *testing.T) {
	t.Run("redirect to another host", func(t *testing.T) {
		other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			t.Error("the other host was reached")
		}))
		defer other.Close()
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, other.URL, http.StatusFound)
		}))
		defer ts.Close()
		var out map[string]any
		if err := getJSON(ctx, NewHTTPClient(nil), ts.URL, "", &out); !errors.Is(err, ErrRedirect) {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("redirect on the same host", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/" {
				http.Redirect(w, r, "/there", http.StatusFound)
				return
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
		}))
		defer ts.Close()
		var out map[string]any
		if err := getJSON(ctx, NewHTTPClient(nil), ts.URL, "", &out); err != nil || out["ok"] != true {
			t.Errorf("%v, %v", out, err)
		}
	})
	t.Run("oversized response", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write(make([]byte, maxResponseBytes+10))
		}))
		defer ts.Close()
		var out map[string]any
		if err := getJSON(ctx, NewHTTPClient(nil), ts.URL, "", &out); err == nil || !strings.Contains(err.Error(), "too large") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("link-local address", func(t *testing.T) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://169.254.169.254/latest/meta-data", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := NewHTTPClient(nil).Do(req)
		if err == nil {
			_ = resp.Body.Close()
		}
		if !errors.Is(err, ErrAddress) {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("a failure keeps the body out of the error", func(t *testing.T) {
		ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("not json, the-secret-token"))
		}))
		defer ts.Close()
		var out map[string]any
		if err := getJSON(ctx, NewHTTPClient(nil), ts.URL, "", &out); err == nil || strings.Contains(err.Error(), "secret") {
			t.Errorf("err = %v", err)
		}
	})
}

func TestLoadRoots(t *testing.T) {
	if roots, err := LoadRoots(""); roots != nil || err != nil {
		t.Errorf("empty path: %v, %v", roots, err)
	}
	dir := t.TempDir()
	if _, err := LoadRoots(filepath.Join(dir, "missing.pem")); err == nil {
		t.Error("a missing file passed")
	}
	bad := filepath.Join(dir, "bad.pem")
	if err := os.WriteFile(bad, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadRoots(bad); err == nil {
		t.Error("a file with no certificates passed")
	}

	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer ts.Close()
	var out map[string]any
	if err := getJSON(ctx, NewHTTPClient(nil), ts.URL, "", &out); err == nil {
		t.Fatal("an unknown authority passed")
	}
	good := filepath.Join(dir, "ca.pem")
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ts.Certificate().Raw})
	if err := os.WriteFile(good, data, 0o600); err != nil {
		t.Fatal(err)
	}
	roots, err := LoadRoots(good)
	if err != nil {
		t.Fatal(err)
	}
	if err := getJSON(ctx, NewHTTPClient(roots), ts.URL, "", &out); err != nil {
		t.Errorf("with the authority: %v", err)
	}
}

func TestFlowSeal(t *testing.T) {
	key := make([]byte, 32)
	now := time.Unix(1_800_000_000, 0)
	f := NewFlow(now)
	f.InviteID = "invite"
	if f.State == f.Nonce || f.Nonce == f.Verifier {
		t.Fatal("secrets repeat")
	}
	sealed, err := f.Seal(key)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sealed, f.Verifier) {
		t.Error("the verifier is readable in the cookie")
	}
	got, err := OpenFlow(key, sealed, now)
	if err != nil || got != f {
		t.Fatalf("open = %+v, %v", got, err)
	}
	if _, err := OpenFlow(key, sealed, now.Add(FlowTTL)); !errors.Is(err, ErrFlow) {
		t.Errorf("expired: %v", err)
	}
	other := make([]byte, 32)
	other[0] = 1
	if _, err := OpenFlow(other, sealed, now); !errors.Is(err, ErrFlow) {
		t.Errorf("another key: %v", err)
	}
	for _, bad := range []string{"", "!!", sealed[:10], "A" + sealed[1:]} {
		if bad == sealed {
			continue
		}
		if _, err := OpenFlow(key, bad, now); !errors.Is(err, ErrFlow) {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func testClient() Client {
	return Client{ID: oidctest.ClientID, Secret: oidctest.ClientSecret, RedirectURI: "https://drive.example.com/auth/oidc/callback", Scopes: "openid email"}
}

// signIn walks the code flow against the fake.
func signIn(t *testing.T, fake *oidctest.Provider, p *Provider, fresh bool) (Tokens, Flow, error) {
	t.Helper()
	f := NewFlow(time.Now())
	target, err := p.AuthorizationURL(testClient(), f, fresh)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(target) //nolint:noctx // a test
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("authorize: %d", resp.StatusCode)
	}
	back, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if back.Query().Get("state") != f.State {
		t.Fatalf("state = %q", back.Query().Get("state"))
	}
	tokens, err := p.Exchange(ctx, testClient(), back.Query().Get("code"), f.Verifier)
	return tokens, f, err
}

func TestCodeFlow(t *testing.T) {
	for _, tc := range []struct {
		name     string
		alg      string
		postOnly bool
	}{
		{"RS256 with basic", "RS256", false},
		{"ES256 with basic", "ES256", false},
		{"EdDSA with post", "EdDSA", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := oidctest.New(t)
			c := &clock{t: time.Unix(1_800_000_000, 0)}
			fake.Now = c.now
			fake.Alg = tc.alg
			fake.PostOnly = tc.postOnly
			fake.Claims = map[string]any{"sub": "s1", "email": "a@example.com", "email_verified": true, "preferred_username": "alice", "groups": []any{"x", "y"}}
			p, err := Discover(ctx, NewHTTPClient(nil), fake.Issuer(), true, c.now)
			if err != nil {
				t.Fatal(err)
			}
			tokens, f, err := signIn(t, fake, p, false)
			if err != nil {
				t.Fatal(err)
			}
			claims, err := p.VerifyIDToken(ctx, tokens.IDToken, oidctest.ClientID, f.Nonce)
			if err != nil {
				t.Fatal(err)
			}
			if claims.Subject != "s1" || claims.Email != "a@example.com" || !claims.EmailVerified || claims.PreferredUsername != "alice" {
				t.Errorf("claims = %+v", claims)
			}
			if g := claims.StringList("groups"); len(g) != 2 || g[1] != "y" {
				t.Errorf("groups = %v", g)
			}
		})
	}
}

func TestExchangeFailures(t *testing.T) {
	fake, p, _ := newFake(t)
	if _, err := p.Exchange(ctx, testClient(), "no such code", "verifier"); !errors.Is(err, ErrExchange) {
		t.Errorf("unknown code: %v", err)
	}
	// A wrong verifier is what PKCE refuses: a stolen code is useless.
	f := NewFlow(time.Now())
	target, _ := p.AuthorizationURL(testClient(), f, false)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(target) //nolint:noctx // a test
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	back, _ := url.Parse(resp.Header.Get("Location"))
	if _, err := p.Exchange(ctx, testClient(), back.Query().Get("code"), "another verifier"); !errors.Is(err, ErrExchange) {
		t.Errorf("wrong verifier: %v", err)
	}
	wrong := testClient()
	wrong.Secret = "wrong"
	tokens, _, err := signIn(t, fake, p, false)
	if err != nil || tokens.AccessToken == "" {
		t.Fatalf("%+v, %v", tokens, err)
	}
	fake.RefuseToken = true
	if _, _, err := signIn(t, fake, p, false); !errors.Is(err, ErrExchange) {
		t.Errorf("refused: %v", err)
	}
	fake.RefuseToken = false
	if _, err := p.Exchange(ctx, wrong, "x", "y"); !errors.Is(err, ErrExchange) {
		t.Errorf("wrong secret: %v", err)
	}
}

func TestAuthorizationURLAsksForFreshLogin(t *testing.T) {
	fake, p, _ := newFake(t)
	if _, _, err := signIn(t, fake, p, false); err != nil {
		t.Fatal(err)
	}
	q := fake.LastAuthorize()
	if q.Has("prompt") {
		t.Error("prompt on an ordinary sign-in")
	}
	if q.Get("code_challenge") == "" || q.Get("scope") != "openid email" {
		t.Errorf("query = %v", q)
	}
	if _, _, err := signIn(t, fake, p, true); err != nil {
		t.Fatal(err)
	}
	if fake.LastAuthorize().Get("prompt") != "login" {
		t.Error("no prompt on a fresh login")
	}
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// handMade builds a token from raw parts, for what the fake would not sign.
func handMade(header, claims map[string]any, signature []byte) string {
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	return b64url(h) + "." + b64url(c) + "." + b64url(signature)
}

func goodClaims(p *Provider, c *clock) map[string]any {
	return map[string]any{
		"iss": p.Metadata().Issuer, "aud": oidctest.ClientID, "sub": "s1",
		"exp": c.now().Unix() + 300, "iat": c.now().Unix(), "nonce": testNonce,
	}
}

// TestForgeries is every way a token can be wrong. Each case must fail for its own
// reason, not by accident, so the reason is checked as well as the failure.
func TestForgeries(t *testing.T) {
	wrongRSA, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	_, wrongEd, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		make func(fake *oidctest.Provider)
		want error
	}{
		{"wrong issuer", func(f *oidctest.Provider) { f.Claims["iss"] = "https://evil.example" }, errIssuer},
		{"no issuer", func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { delete(c, "iss") }
		}, errIssuer},
		{"wrong audience", func(f *oidctest.Provider) { f.Claims["aud"] = "another-client" }, errAudience},
		{"no audience", func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { delete(c, "aud") }
		}, errAudience},
		{"audience as a list without us", func(f *oidctest.Provider) { f.Claims["aud"] = []any{"a", "b"} }, errAudience},
		{"several audiences and no azp", func(f *oidctest.Provider) { f.Claims["aud"] = []any{oidctest.ClientID, "b"} }, errParty},
		{"another authorized party", func(f *oidctest.Provider) {
			f.Claims["aud"] = []any{oidctest.ClientID, "b"}
			f.Claims["azp"] = "b"
		}, errParty},
		{"azp alone wrong", func(f *oidctest.Provider) { f.Claims["azp"] = "b" }, errParty},
		{"bad nonce", func(f *oidctest.Provider) { f.Claims["nonce"] = "another" }, errNonce},
		{"no nonce", func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { delete(c, "nonce") }
		}, errNonce},
		{"expired", func(f *oidctest.Provider) { f.Claims["exp"] = f.Now().Unix() - 3600 }, errExpired},
		{"no expiry", func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { delete(c, "exp") }
		}, errExpired},
		{"expiry as a string", func(f *oidctest.Provider) { f.Claims["exp"] = "9999999999" }, errExpired},
		{"issued in the future", func(f *oidctest.Provider) { f.Claims["iat"] = f.Now().Unix() + 3600 }, errIssuedAt},
		{"no issue time", func(f *oidctest.Provider) {
			f.Forge = func(_, c map[string]any) { delete(c, "iat") }
		}, errIssuedAt},
		{"not valid yet", func(f *oidctest.Provider) { f.Claims["nbf"] = f.Now().Unix() + 3600 }, errIssuedAt},
		{"empty subject", func(f *oidctest.Provider) { f.Claims["sub"] = "" }, errSubject},
		{"no subject", func(f *oidctest.Provider) { delete(f.Claims, "sub") }, errSubject},
		{"overlong subject", func(f *oidctest.Provider) { f.Claims["sub"] = strings.Repeat("s", 256) }, errSubject},
		{"signed with another RSA key", func(f *oidctest.Provider) {
			f.Signer = func(input string) []byte { return oidctest.SignRS256(wrongRSA, input) }
		}, errSignature},
		{"signed with another Ed25519 key", func(f *oidctest.Provider) {
			f.Alg = "EdDSA"
			f.Signer = func(input string) []byte { return ed25519.Sign(wrongEd, []byte(input)) }
		}, errSignature},
		{"no signature", func(f *oidctest.Provider) {
			f.Signer = func(string) []byte { return nil }
		}, errSignature},
		{"a key id nobody has", func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["kid"] = "nobody" }
		}, errNoKey},
		{"a key id of another algorithm", func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["kid"] = oidctest.KidEC }
		}, errNoKey},
		{"alg none", func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["alg"] = "none" }
			f.Signer = func(string) []byte { return nil }
		}, errAlg},
		{"alg None, case changed", func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["alg"] = "None" }
			f.Signer = func(string) []byte { return nil }
		}, errAlg},
		{"HS256 with the public key as the secret", func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["alg"] = "HS256" }
			f.Signer = func(input string) []byte {
				der, err := x509.MarshalPKIXPublicKey(f.PublicRSA())
				if err != nil {
					t.Fatal(err)
				}
				mac := hmac.New(sha256.New, der)
				_, _ = mac.Write([]byte(input))
				return mac.Sum(nil)
			}
		}, errAlg},
		{"RS512", func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["alg"] = "RS512" }
		}, errAlg},
		{"an extension nobody understands", func(f *oidctest.Provider) {
			f.Forge = func(h, _ map[string]any) { h["crit"] = []string{"exp"} }
		}, errMalformed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake, p, _ := newFake(t)
			tc.make(fake)
			_, err := p.VerifyIDToken(ctx, fake.IDToken(testNonce), oidctest.ClientID, testNonce)
			if !errors.Is(err, ErrToken) || !errors.Is(err, tc.want) {
				t.Errorf("err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestMalformedTokens(t *testing.T) {
	_, p, c := newFake(t)
	good := goodClaims(p, c)
	for name, token := range map[string]string{
		"empty":        "",
		"two parts":    "a.b",
		"four parts":   "a.b.c.d",
		"bad header":   "!.e30.AA",
		"json-free":    b64url([]byte("nope")) + ".e30.AA",
		"huge":         strings.Repeat("a", maxTokenBytes+1),
		"bad sig b64":  handMade(map[string]any{"alg": "RS256", "kid": oidctest.KidRSA}, good, nil) + "!",
		"padded parts": b64url([]byte(`{"alg":"RS256"}`)) + "==.e30.AA",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := p.VerifyIDToken(ctx, token, oidctest.ClientID, testNonce); !errors.Is(err, ErrToken) {
				t.Errorf("err = %v", err)
			}
		})
	}
}

func TestSkewIsSmallButThere(t *testing.T) {
	fake, p, c := newFake(t)
	fake.Claims["exp"] = c.now().Unix() - int64(clockSkew.Seconds()) + 5
	fake.Claims["iat"] = c.now().Unix() + int64(clockSkew.Seconds()) - 5
	if _, err := p.VerifyIDToken(ctx, fake.IDToken(testNonce), oidctest.ClientID, testNonce); err != nil {
		t.Errorf("within the skew: %v", err)
	}
	fake.Claims["exp"] = c.now().Unix() - int64(clockSkew.Seconds()) - 5
	if _, err := p.VerifyIDToken(ctx, fake.IDToken(testNonce), oidctest.ClientID, testNonce); !errors.Is(err, errExpired) {
		t.Errorf("past the skew: %v", err)
	}
}

func TestTokenWithoutKidUsesTheOnlyKeyOfItsKind(t *testing.T) {
	fake, p, _ := newFake(t)
	fake.Alg = "EdDSA"
	fake.Forge = func(h, _ map[string]any) { delete(h, "kid") }
	if _, err := p.VerifyIDToken(ctx, fake.IDToken(testNonce), oidctest.ClientID, testNonce); err != nil {
		t.Errorf("err = %v", err)
	}
}

func TestKeysAreCachedAndRefreshedOnAnUnknownKid(t *testing.T) {
	fake, p, c := newFake(t)
	verify := func() error {
		_, err := p.VerifyIDToken(ctx, fake.IDToken(testNonce), oidctest.ClientID, testNonce)
		return err
	}
	for range 3 {
		if err := verify(); err != nil {
			t.Fatal(err)
		}
	}
	if n := fake.JWKSCalls(); n != 1 {
		t.Errorf("fetched %d times for one key", n)
	}

	// A rotation at the provider works from the first token, a minute on.
	c.advance(keysRefreshInterval)
	newKey := fake.RotateIn(t, "rsa-2")
	fake.Forge = func(h, _ map[string]any) { h["kid"] = "rsa-2" }
	fake.Signer = func(input string) []byte { return oidctest.SignRS256(newKey, input) }
	if err := verify(); err != nil {
		t.Errorf("after the rotation: %v", err)
	}
	if n := fake.JWKSCalls(); n != 2 {
		t.Errorf("fetched %d times, want 2", n)
	}

	// Forged ids do not turn into a stream of fetches.
	fake.Forge = func(h, _ map[string]any) { h["kid"] = "forged" }
	for range 5 {
		if err := verify(); !errors.Is(err, errNoKey) {
			t.Errorf("forged id: %v", err)
		}
	}
	if n := fake.JWKSCalls(); n != 2 {
		t.Errorf("fetched %d times after forged ids", n)
	}
	c.advance(keysRefreshInterval)
	_ = verify()
	if n := fake.JWKSCalls(); n != 3 {
		t.Errorf("fetched %d times a minute on", n)
	}
}

func TestWeakKeysAreStepped(t *testing.T) {
	small, err := rsa.GenerateKey(rand.Reader, 1024) //nolint:gosec // the point of the test
	if err != nil {
		t.Fatal(err)
	}
	k := jwk{Kty: "RSA", N: b64url(small.N.Bytes()), E: "AQAB"}
	if _, ok := k.parse(); ok {
		t.Error("a 1024-bit key was accepted")
	}
	if _, ok := (jwk{Kty: "EC", Crv: "P-256", X: b64url(make([]byte, 32)), Y: b64url(make([]byte, 32))}).parse(); ok {
		t.Error("a point off the curve was accepted")
	}
	if _, ok := (jwk{Kty: "EC", Crv: "P-521", X: "AA", Y: "AA"}).parse(); ok {
		t.Error("a curve with no algorithm here was accepted")
	}
	if _, ok := (jwk{Kty: "oct", N: "AA"}).parse(); ok {
		t.Error("a symmetric key was accepted")
	}
	large, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := (jwk{Kty: "RSA", Alg: "RS512", N: b64url(large.N.Bytes()), E: "AQAB"}).parse(); ok {
		t.Error("a key for another algorithm was accepted")
	}
	if _, ok := (jwk{Kty: "RSA", Use: "enc", N: b64url(large.N.Bytes()), E: "AQAB"}).parse(); ok {
		t.Error("an encryption key was accepted")
	}
}

func TestUserInfo(t *testing.T) {
	fake, p, _ := newFake(t)
	fake.Claims = map[string]any{"sub": "s1"}
	fake.UserInfo = map[string]any{"email": "a@example.com", "email_verified": true, "groups": []any{"x"}}
	info, err := p.UserInfo(ctx, "token", "s1")
	if err != nil || info.Email != "a@example.com" {
		t.Fatalf("%+v, %v", info, err)
	}
	if _, err := p.UserInfo(ctx, "token", "another"); !errors.Is(err, ErrUserInfo) {
		t.Errorf("another subject: %v", err)
	}
}

func TestFillOverridesNothing(t *testing.T) {
	token := parseClaims(map[string]any{"sub": "s1", "email": "a@example.com", "email_verified": false, "groups": "own"})
	info := parseClaims(map[string]any{"sub": "s1", "email": "b@example.com", "email_verified": true, "groups": []any{"other"}, "preferred_username": "alice"})
	got := token.Fill(info)
	if got.Email != "a@example.com" || got.EmailVerified {
		t.Errorf("a verification crossed to another address: %+v", got)
	}
	if g := got.StringList("groups"); len(g) != 1 || g[0] != "own" {
		t.Errorf("groups = %v", g)
	}
	if got.PreferredUsername != "alice" {
		t.Errorf("username = %q", got.PreferredUsername)
	}
	if token.Has("preferred_username") {
		t.Error("the original changed")
	}

	same := parseClaims(map[string]any{"sub": "s1", "email": "a@example.com"}).Fill(
		parseClaims(map[string]any{"sub": "s1", "email": "a@example.com", "email_verified": true}))
	if !same.EmailVerified {
		t.Error("a verification of the same address did not count")
	}
	empty := parseClaims(map[string]any{"sub": "s1"}).Fill(
		parseClaims(map[string]any{"sub": "s1", "email": "a@example.com", "email_verified": "true"}))
	if empty.Email != "a@example.com" || empty.EmailVerified {
		t.Errorf("a string counted as verified: %+v", empty)
	}
}

func TestLoadRootsRefusesWithoutSystemRoots(t *testing.T) {
	want := errors.New("no system roots")
	old := systemCertPool
	systemCertPool = func() (*x509.CertPool, error) { return nil, want }
	t.Cleanup(func() { systemCertPool = old })
	ca := filepath.Join(t.TempDir(), "ca.pem")
	ts := httptest.NewTLSServer(http.NotFoundHandler())
	defer ts.Close()
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ts.Certificate().Raw})
	if err := os.WriteFile(ca, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if roots, err := LoadRoots(ca); !errors.Is(err, want) || roots != nil {
		t.Errorf("LoadRoots = %v, %v", roots, err)
	}
}
