// Package oidctest is a local identity provider for tests. It does what a real one
// checks, PKCE and the client's secret included, so that a test passes only if
// the client behaves, and it can sign whatever a test wants to forge.
package oidctest

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// Key ids of the provider's three keys.
const (
	KidRSA = "rsa-1"
	KidEC  = "ec-1"
	KidEd  = "ed-1"
)

// Credentials of the client the provider knows.
const (
	ClientID     = "yondrive"
	ClientSecret = "the client secret/+"
)

var (
	rsaOnce sync.Once
	rsaKey  *rsa.PrivateKey
)

// sharedRSAKey keeps the suite quick: generating one takes a while under -race.
func sharedRSAKey() *rsa.PrivateKey {
	rsaOnce.Do(func() {
		var err error
		if rsaKey, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
			panic(err)
		}
	})
	return rsaKey
}

// Provider is the fake. Set its fields before a sign-in, under no lock: tests
// drive it in sequence.
type Provider struct {
	*httptest.Server

	// Now is the clock of the tokens it issues.
	Now func() time.Time
	// Claims are the claims of who signs in next, on top of those the token needs.
	Claims map[string]any
	// UserInfo is what the userinfo endpoint answers, on top of the subject.
	UserInfo map[string]any
	// Alg picks the signing key: RS256 (the default), ES256 or EdDSA.
	Alg string
	// Forge changes a token just before it is signed.
	Forge func(header, claims map[string]any)
	// Signer replaces the signature of an issued token, for tokens signed with
	// something else.
	Signer func(signingInput string) []byte
	// Document changes the discovery document before it is sent.
	Document func(doc map[string]any)
	// RefuseToken makes the token endpoint fail.
	RefuseToken bool
	// PostOnly restricts client authentication to client_secret_post, and discovery says so.
	PostOnly bool

	mu            sync.Mutex
	codes         map[string]issuedCode
	userInfoCalls int
	jwksCalls     int
	extraKeys     []map[string]any
	lastAuthorize url.Values

	rsa *rsa.PrivateKey
	ec  *ecdsa.PrivateKey
	ed  ed25519.PrivateKey
}

type issuedCode struct {
	challenge, redirectURI, nonce string
}

// New starts a provider at its own loopback address, plain http: the client under
// test needs its allow-insecure setting for it.
func New(t testing.TB) *Provider {
	t.Helper()
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, ed, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p := &Provider{
		Now:    time.Now,
		Claims: map[string]any{"sub": "subject-1"},
		codes:  map[string]issuedCode{},
		rsa:    sharedRSAKey(),
		ec:     ec,
		ed:     ed,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", p.discovery)
	mux.HandleFunc("GET /authorize", p.authorize)
	mux.HandleFunc("POST /token", p.token)
	mux.HandleFunc("GET /jwks", p.jwks)
	mux.HandleFunc("GET /userinfo", p.userinfo)
	p.Server = httptest.NewServer(mux)
	t.Cleanup(p.Close)
	return p
}

// Issuer is the provider's address, which it also calls itself.
func (p *Provider) Issuer() string { return p.URL }

// UserInfoCalls says how many times userinfo was fetched.
func (p *Provider) UserInfoCalls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.userInfoCalls
}

// JWKSCalls says how many times the keys were fetched.
func (p *Provider) JWKSCalls() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.jwksCalls
}

// LastAuthorize returns the query of the last authorization request.
func (p *Provider) LastAuthorize() url.Values {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.lastAuthorize
}

// RotateIn publishes another RSA key, from now on, and returns it for signing.
func (p *Provider) RotateIn(t testing.TB, kid string) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.extraKeys = append(p.extraKeys, rsaJWK(kid, &key.PublicKey))
	return key
}

func (p *Provider) discovery(w http.ResponseWriter, _ *http.Request) {
	methods := []string{"client_secret_basic", "client_secret_post"}
	if p.PostOnly {
		methods = []string{"client_secret_post"}
	}
	doc := map[string]any{
		"issuer":                                p.URL,
		"authorization_endpoint":                p.URL + "/authorize",
		"token_endpoint":                        p.URL + "/token",
		"jwks_uri":                              p.URL + "/jwks",
		"userinfo_endpoint":                     p.URL + "/userinfo",
		"response_types_supported":              []string{"code"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": methods,
		"id_token_signing_alg_values_supported": []string{"RS256", "ES256", "EdDSA"},
	}
	if p.Document != nil {
		p.Document(doc)
	}
	writeJSON(w, doc)
}

// authorize signs whoever is next in at once, as a provider with a session does.
func (p *Provider) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("response_type") != "code" || q.Get("client_id") != ClientID || q.Get("code_challenge_method") != "S256" ||
		q.Get("code_challenge") == "" || q.Get("redirect_uri") == "" || q.Get("state") == "" || q.Get("nonce") == "" {
		http.Error(w, "bad authorization request", http.StatusBadRequest)
		return
	}
	code := token()
	p.mu.Lock()
	p.lastAuthorize = q
	p.codes[code] = issuedCode{challenge: q.Get("code_challenge"), redirectURI: q.Get("redirect_uri"), nonce: q.Get("nonce")}
	p.mu.Unlock()
	back, err := url.Parse(q.Get("redirect_uri"))
	if err != nil {
		http.Error(w, "bad redirect", http.StatusBadRequest)
		return
	}
	v := back.Query()
	v.Set("code", code)
	v.Set("state", q.Get("state"))
	back.RawQuery = v.Encode()
	http.Redirect(w, r, back.String(), http.StatusFound) //nolint:gosec // a test double, whose redirect target is what the client under test sent
}

func (p *Provider) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil || p.RefuseToken {
		http.Error(w, `{"error":"invalid_request"}`, http.StatusBadRequest)
		return
	}
	id, secret := r.PostForm.Get("client_id"), r.PostForm.Get("client_secret")
	if !p.PostOnly {
		if user, pass, ok := r.BasicAuth(); ok {
			id, _ = url.QueryUnescape(user)
			secret, _ = url.QueryUnescape(pass)
		}
	}
	if id != ClientID || secret != ClientSecret {
		http.Error(w, `{"error":"invalid_client"}`, http.StatusUnauthorized)
		return
	}
	code := r.PostForm.Get("code")
	p.mu.Lock()
	issued, ok := p.codes[code]
	delete(p.codes, code)
	p.mu.Unlock()
	sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
	if !ok || r.PostForm.Get("grant_type") != "authorization_code" || r.PostForm.Get("redirect_uri") != issued.redirectURI ||
		base64.RawURLEncoding.EncodeToString(sum[:]) != issued.challenge {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]any{
		"access_token": "access-token",
		"token_type":   "Bearer",
		"id_token":     p.IDToken(issued.nonce),
	})
}

// IDToken issues a token for the next signer-in, with the given nonce.
func (p *Provider) IDToken(nonce string) string {
	now := p.Now().Unix()
	claims := map[string]any{"iss": p.URL, "aud": ClientID, "exp": now + 300, "iat": now, "nonce": nonce}
	for k, v := range p.Claims {
		claims[k] = v
	}
	alg := p.Alg
	if alg == "" {
		alg = "RS256"
	}
	header := map[string]any{"typ": "JWT", "alg": alg}
	switch alg {
	case "ES256":
		header["kid"] = KidEC
	case "EdDSA":
		header["kid"] = KidEd
	default:
		header["kid"] = KidRSA
	}
	if p.Forge != nil {
		p.Forge(header, claims)
	}
	input := segment(header) + "." + segment(claims)
	var sig []byte
	if p.Signer != nil {
		sig = p.Signer(input)
	} else {
		sig = p.sign(alg, input)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func (p *Provider) sign(alg, input string) []byte {
	switch alg {
	case "ES256":
		return SignES256(p.ec, input)
	case "EdDSA":
		return ed25519.Sign(p.ed, []byte(input))
	}
	return SignRS256(p.rsa, input)
}

// SignRS256 signs as RS256.
func SignRS256(key *rsa.PrivateKey, input string) []byte {
	digest := sha256.Sum256([]byte(input))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		panic(err)
	}
	return sig
}

// SignES256 signs as ES256.
func SignES256(key *ecdsa.PrivateKey, input string) []byte {
	digest := sha256.Sum256([]byte(input))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		panic(err)
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return out
}

// PublicRSA is the public half of the provider's RSA key, as a forger holds it.
func (p *Provider) PublicRSA() *rsa.PublicKey { return &p.rsa.PublicKey }

func (p *Provider) jwks(w http.ResponseWriter, _ *http.Request) {
	x, y := make([]byte, 32), make([]byte, 32)
	ecdhKey, err := p.ec.PublicKey.ECDH()
	if err != nil {
		http.Error(w, "key", http.StatusInternalServerError)
		return
	}
	raw := ecdhKey.Bytes()
	copy(x, raw[1:33])
	copy(y, raw[33:65])
	p.mu.Lock()
	defer p.mu.Unlock()
	p.jwksCalls++
	keys := []map[string]any{
		rsaJWK(KidRSA, &p.rsa.PublicKey),
		{"kty": "EC", "kid": KidEC, "use": "sig", "alg": "ES256", "crv": "P-256", "x": b64(x), "y": b64(y)},
		{"kty": "OKP", "kid": KidEd, "use": "sig", "alg": "EdDSA", "crv": "Ed25519", "x": b64(p.ed.Public().(ed25519.PublicKey))},
		// What a real set also holds, and a client must step over.
		{"kty": "RSA", "kid": "enc-1", "use": "enc", "n": "AQAB", "e": "AQAB"},
	}
	writeJSON(w, map[string]any{"keys": append(keys, p.extraKeys...)})
}

func rsaJWK(kid string, pub *rsa.PublicKey) map[string]any {
	return map[string]any{
		"kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256",
		"n": b64(pub.N.Bytes()), "e": b64(big.NewInt(int64(pub.E)).Bytes()),
	}
}

func (p *Provider) userinfo(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
		http.Error(w, "no token", http.StatusUnauthorized)
		return
	}
	p.mu.Lock()
	p.userInfoCalls++
	p.mu.Unlock()
	doc := map[string]any{"sub": p.Claims["sub"]}
	for k, v := range p.UserInfo {
		doc[k] = v
	}
	writeJSON(w, doc)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func segment(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(data)
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func token() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return b64(b[:])
}
