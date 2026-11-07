package oidc

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// FlowTTL is how long a sign-in may take from leaving for the provider to coming
// back.
const FlowTTL = 10 * time.Minute

// FreshMaxAge is how long ago a fresh sign-in may have authenticated at the
// provider, which it asks for as max_age and checks in auth_time.
const FreshMaxAge = 5 * time.Minute

// flowAAD binds a sealed flow to its purpose.
var flowAAD = []byte("yondrive/oidc-flow/v1")

// ErrFlow means a flow cookie is missing, forged, expired or for another sign-in.
var ErrFlow = errors.New("oidc: sign-in flow is not valid")

// Flow is what one sign-in must remember between leaving for the provider and
// coming back. It travels in a cookie, sealed: the server keeps nothing per
// sign-in, so an anonymous flood of sign-ins costs it no memory.
type Flow struct {
	State     string `json:"s"`
	Nonce     string `json:"n"`
	Verifier  string `json:"v"`
	ExpiresAt int64  `json:"e"`
	// InviteID is the invite the sign-in was started with, if any.
	InviteID string `json:"i,omitempty"`
	// Fresh is a sign-in that asked the provider to authenticate again, to stand
	// in for a current credential.
	Fresh bool `json:"f,omitempty"`
}

// NewFlow draws the secrets of a sign-in.
func NewFlow(now time.Time) Flow {
	return Flow{
		State:     randomToken(),
		Nonce:     randomToken(),
		Verifier:  randomToken(),
		ExpiresAt: now.Add(FlowTTL).Unix(),
	}
}

func randomToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// challenge is the S256 code challenge of a verifier.
func challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Seal encrypts a flow under a 32-byte key.
func (f Flow) Seal(key []byte) (string, error) {
	aead, err := flowCipher(key)
	if err != nil {
		return "", err
	}
	plain, err := json.Marshal(f)
	if err != nil {
		return "", fmt.Errorf("oidc: seal flow: %w", err)
	}
	nonce := make([]byte, aead.NonceSize())
	_, _ = rand.Read(nonce)
	return base64.RawURLEncoding.EncodeToString(aead.Seal(nonce, nonce, plain, flowAAD)), nil
}

// OpenFlow decrypts a sealed flow and checks that it is still in time.
func OpenFlow(key []byte, sealed string, now time.Time) (Flow, error) {
	aead, err := flowCipher(key)
	if err != nil {
		return Flow{}, err
	}
	raw, err := base64.RawURLEncoding.DecodeString(sealed)
	if err != nil || len(raw) < aead.NonceSize() {
		return Flow{}, ErrFlow
	}
	plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], flowAAD)
	if err != nil {
		return Flow{}, ErrFlow
	}
	var f Flow
	if err := json.Unmarshal(plain, &f); err != nil || now.Unix() >= f.ExpiresAt {
		return Flow{}, ErrFlow
	}
	return f, nil
}

func flowCipher(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("oidc: flow key: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("oidc: flow key: %w", err)
	}
	return aead, nil
}

// Client is this server as the provider knows it.
type Client struct {
	ID          string
	Secret      string //nolint:gosec // holds the secret by design, and is never marshalled
	RedirectURI string
	Scopes      string
}

// AuthorizationURL is where the browser goes to sign in. For a fresh flow the
// provider is asked to authenticate again, whatever session it already has, and
// to say when it did in auth_time.
func (p *Provider) AuthorizationURL(c Client, f Flow) (string, error) {
	u, err := url.Parse(p.meta.AuthorizationEndpoint)
	if err != nil {
		return "", fmt.Errorf("%w: unusable endpoint", ErrDiscovery)
	}
	q := u.Query()
	q.Set("response_type", "code")
	q.Set("client_id", c.ID)
	q.Set("redirect_uri", c.RedirectURI)
	q.Set("scope", c.Scopes)
	q.Set("state", f.State)
	q.Set("nonce", f.Nonce)
	q.Set("code_challenge", challenge(f.Verifier))
	q.Set("code_challenge_method", "S256")
	if f.Fresh {
		q.Set("prompt", "login")
		q.Set("max_age", strconv.Itoa(int(FreshMaxAge.Seconds())))
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

// Tokens is what the token endpoint answers.
type Tokens struct {
	IDToken     string `json:"id_token"`
	AccessToken string `json:"access_token"` //nolint:gosec // holds a token by design, and is only ever read from a provider
}

// Exchange trades a code for tokens, authenticating as the provider asks for.
func (p *Provider) Exchange(ctx context.Context, c Client, code, verifier string) (Tokens, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {c.RedirectURI},
		"code_verifier": {verifier},
	}
	if p.authMethod == authPost {
		form.Set("client_id", c.ID)
		form.Set("client_secret", c.Secret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.meta.TokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return Tokens{}, fmt.Errorf("%w: request", ErrExchange)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	if p.authMethod == authBasic {
		// RFC 6749, section 2.3.1: both parts are form encoded first.
		req.SetBasicAuth(url.QueryEscape(c.ID), url.QueryEscape(c.Secret))
	}
	var tokens Tokens
	if err := doJSON(p.http, req, &tokens); err != nil {
		return Tokens{}, fmt.Errorf("%w: %w", ErrExchange, err)
	}
	if tokens.IDToken == "" {
		return Tokens{}, fmt.Errorf("%w: no ID token", ErrExchange)
	}
	return tokens, nil
}
