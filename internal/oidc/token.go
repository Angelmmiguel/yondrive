package oidc

import (
	"context"
	"crypto"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math/big"
	"slices"
	"strings"
	"time"
)

// The signature algorithms an ID token may use. The name in a token's header is
// only ever looked up here: there is no case for none or for HS*, and a key's own
// type has to fit the algorithm named, so a public key cannot be passed off as a
// shared secret.
const (
	algRS256 = "RS256"
	algES256 = "ES256"
	algEdDSA = "EdDSA"
)

// Bounds of what is accepted from a provider.
const (
	// clockSkew is how far this server's clock and the provider's may disagree.
	clockSkew     = time.Minute
	maxTokenBytes = 64 << 10
	maxSubjectLen = 255
	minRSABits    = 2048
	maxRSABits    = 8192
	ed25519KeyLen = 32
	es256FieldLen = 32
)

// ErrToken means an ID token failed verification. Every reason wraps it.
var ErrToken = errors.New("oidc: ID token rejected")

var (
	errMalformed = fmt.Errorf("%w: malformed", ErrToken)
	errAlg       = fmt.Errorf("%w: algorithm not allowed", ErrToken)
	errNoKey     = fmt.Errorf("%w: no key for it", ErrToken)
	errSignature = fmt.Errorf("%w: bad signature", ErrToken)
	errIssuer    = fmt.Errorf("%w: wrong issuer", ErrToken)
	errAudience  = fmt.Errorf("%w: wrong audience", ErrToken)
	errParty     = fmt.Errorf("%w: wrong authorized party", ErrToken)
	errExpired   = fmt.Errorf("%w: expired", ErrToken)
	errIssuedAt  = fmt.Errorf("%w: bad issue time", ErrToken)
	errNonce     = fmt.Errorf("%w: wrong nonce", ErrToken)
	errSubject   = fmt.Errorf("%w: bad subject", ErrToken)
)

// Claims is what an identity token and userinfo say about someone.
type Claims struct {
	Subject           string
	Email             string
	EmailVerified     bool
	PreferredUsername string
	raw               map[string]any
}

func parseClaims(raw map[string]any) Claims {
	c := Claims{raw: raw}
	c.Subject, _ = raw["sub"].(string)
	c.Email, _ = raw["email"].(string)
	c.PreferredUsername, _ = raw["preferred_username"].(string)
	// True or nothing: a provider that says anything else has not verified it.
	c.EmailVerified, _ = raw["email_verified"].(bool)
	return c
}

// Has reports whether a claim was given at all.
func (c Claims) Has(name string) bool {
	_, ok := c.raw[name]
	return ok
}

// StringList reads a claim that holds a list of strings or just one.
func (c Claims) StringList(name string) []string {
	switch v := c.raw[name].(type) {
	case string:
		return []string{v}
	case []any:
		out := make([]string, 0, len(v))
		for _, item := range v {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// Fill takes from userinfo what the ID token left out, and overrides nothing.
// A verification only counts for the address the token itself gave.
func (c Claims) Fill(info Claims) Claims {
	out := c
	out.raw = maps.Clone(c.raw)
	for name, value := range info.raw {
		if _, ok := out.raw[name]; !ok {
			out.raw[name] = value
		}
	}
	if out.PreferredUsername == "" {
		out.PreferredUsername = info.PreferredUsername
	}
	switch out.Email {
	case "":
		out.Email, out.EmailVerified = info.Email, info.EmailVerified
	case info.Email:
		out.EmailVerified = out.EmailVerified || info.EmailVerified
	}
	return out
}

// UserInfo fetches the userinfo document, which must be about the same subject.
func (p *Provider) UserInfo(ctx context.Context, accessToken, subject string) (Claims, error) {
	if p.meta.UserinfoEndpoint == "" {
		return Claims{}, fmt.Errorf("%w: no endpoint", ErrUserInfo)
	}
	var raw map[string]any
	if err := getJSON(ctx, p.http, p.meta.UserinfoEndpoint, accessToken, &raw); err != nil {
		return Claims{}, fmt.Errorf("%w: %w", ErrUserInfo, err)
	}
	info := parseClaims(raw)
	if info.Subject != subject {
		return Claims{}, fmt.Errorf("%w: another subject", ErrUserInfo)
	}
	return info, nil
}

// HasUserInfo reports whether the provider publishes a userinfo endpoint.
func (p *Provider) HasUserInfo() bool { return p.meta.UserinfoEndpoint != "" }

// VerifyIDToken checks a token's signature and then its claims, against this
// provider, this client and this sign-in's nonce. Nothing in the token is believed
// before the signature holds.
func (p *Provider) VerifyIDToken(ctx context.Context, raw, clientID, nonce string) (Claims, error) {
	if len(raw) > maxTokenBytes {
		return Claims{}, errMalformed
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return Claims{}, errMalformed
	}
	var header struct {
		Alg  string   `json:"alg"`
		Kid  string   `json:"kid"`
		Crit []string `json:"crit"`
	}
	if err := decodeSegment(parts[0], &header); err != nil {
		return Claims{}, errMalformed
	}
	if header.Alg != algRS256 && header.Alg != algES256 && header.Alg != algEdDSA {
		return Claims{}, errAlg
	}
	// RFC 7515: an extension that is not understood makes the token invalid.
	if len(header.Crit) > 0 {
		return Claims{}, errMalformed
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	if err != nil {
		return Claims{}, errMalformed
	}
	key, err := p.key(ctx, header.Kid, header.Alg)
	if err != nil {
		return Claims{}, err
	}
	if !verifySignature(header.Alg, key, []byte(parts[0]+"."+parts[1]), signature) {
		return Claims{}, errSignature
	}
	var claims map[string]any
	if err := decodeSegment(parts[1], &claims); err != nil {
		return Claims{}, errMalformed
	}
	return p.checkClaims(claims, clientID, nonce)
}

func decodeSegment(segment string, out any) error {
	data, err := base64.RawURLEncoding.Strict().DecodeString(segment)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

func (p *Provider) checkClaims(raw map[string]any, clientID, nonce string) (Claims, error) {
	if iss, _ := raw["iss"].(string); iss != p.meta.Issuer {
		return Claims{}, errIssuer
	}
	c := parseClaims(raw)
	audience := c.StringList("aud")
	if !slices.Contains(audience, clientID) {
		return Claims{}, errAudience
	}
	azp, hasAzp := raw["azp"].(string)
	if hasAzp && azp != clientID {
		return Claims{}, errParty
	}
	// OIDC Core 3.1.3.7: more than one audience needs an authorized party, or
	// a token minted for another client that merely lists this one would pass.
	if len(audience) > 1 && !hasAzp {
		return Claims{}, errParty
	}
	now := p.now()
	exp, ok := numericDate(raw["exp"])
	if !ok || !now.Before(exp.Add(clockSkew)) {
		return Claims{}, errExpired
	}
	iat, ok := numericDate(raw["iat"])
	if !ok || iat.After(now.Add(clockSkew)) {
		return Claims{}, errIssuedAt
	}
	if nbf, ok := numericDate(raw["nbf"]); ok && nbf.After(now.Add(clockSkew)) {
		return Claims{}, errIssuedAt
	}
	got, _ := raw["nonce"].(string)
	if nonce == "" || subtle.ConstantTimeCompare([]byte(got), []byte(nonce)) != 1 {
		return Claims{}, errNonce
	}
	if c.Subject == "" || len(c.Subject) > maxSubjectLen {
		return Claims{}, errSubject
	}
	return c, nil
}

func numericDate(v any) (time.Time, bool) {
	f, ok := v.(float64)
	if !ok || f < 0 || f > 1<<40 {
		return time.Time{}, false
	}
	return time.Unix(int64(f), 0), true
}

func verifySignature(alg string, key crypto.PublicKey, signed, signature []byte) bool {
	switch alg {
	case algRS256:
		pub, ok := key.(*rsa.PublicKey)
		if !ok {
			return false
		}
		digest := sha256.Sum256(signed)
		return rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], signature) == nil
	case algES256:
		pub, ok := key.(*ecdsa.PublicKey)
		if !ok || len(signature) != 2*es256FieldLen {
			return false
		}
		digest := sha256.Sum256(signed)
		r := new(big.Int).SetBytes(signature[:es256FieldLen])
		s := new(big.Int).SetBytes(signature[es256FieldLen:])
		return ecdsa.Verify(pub, digest[:], r, s)
	case algEdDSA:
		pub, ok := key.(ed25519.PublicKey)
		return ok && ed25519.Verify(pub, signed, signature)
	}
	return false
}

// verificationKey is a key of the provider's that this client can use.
type verificationKey struct {
	id  string
	alg string
	pub crypto.PublicKey
}

// jwk is a key as published.
type jwk struct {
	Kty string `json:"kty"`
	Kid string `json:"kid"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// parse returns the key, or false for one this client has no use for: a provider
// is free to publish keys for encryption or for other algorithms beside its own.
func (k jwk) parse() (verificationKey, bool) {
	if k.Use != "" && k.Use != "sig" {
		return verificationKey{}, false
	}
	var out verificationKey
	var ok bool
	switch {
	case k.Kty == "RSA":
		out.alg = algRS256
		out.pub, ok = k.rsaKey()
	case k.Kty == "EC" && k.Crv == "P-256":
		out.alg = algES256
		out.pub, ok = k.ecKey()
	case k.Kty == "OKP" && k.Crv == "Ed25519":
		out.alg = algEdDSA
		var x []byte
		x, ok = decodeB64(k.X)
		ok = ok && len(x) == ed25519KeyLen
		out.pub = ed25519.PublicKey(x)
	}
	if !ok || (k.Alg != "" && k.Alg != out.alg) {
		return verificationKey{}, false
	}
	out.id = k.Kid
	return out, true
}

func decodeB64(s string) ([]byte, bool) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	return b, err == nil
}

func (k jwk) rsaKey() (*rsa.PublicKey, bool) {
	n, okN := decodeB64(k.N)
	e, okE := decodeB64(k.E)
	if !okN || !okE {
		return nil, false
	}
	modulus := new(big.Int).SetBytes(n)
	exponent := new(big.Int).SetBytes(e)
	if bits := modulus.BitLen(); bits < minRSABits || bits > maxRSABits {
		return nil, false
	}
	if !exponent.IsInt64() || exponent.Int64() < 3 || exponent.Int64() > 1<<31-1 || exponent.Bit(0) == 0 {
		return nil, false
	}
	return &rsa.PublicKey{N: modulus, E: int(exponent.Int64())}, true
}

func (k jwk) ecKey() (*ecdsa.PublicKey, bool) {
	x, okX := decodeB64(k.X)
	y, okY := decodeB64(k.Y)
	if !okX || !okY || len(x) != es256FieldLen || len(y) != es256FieldLen {
		return nil, false
	}
	// ecdh checks that the point is on the curve: an invalid point is an attack.
	if _, err := ecdh.P256().NewPublicKey(slices.Concat([]byte{4}, x, y)); err != nil {
		return nil, false
	}
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}, true //nolint:staticcheck // ecdsa.Verify takes these fields
}

// key finds the key a token names, fetching the keys when it is not among those
// held: a provider that rotates publishes the new key before using it.
func (p *Provider) key(ctx context.Context, kid, alg string) (crypto.PublicKey, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if key, ok := findKey(p.keys, kid, alg); ok {
		return key, nil
	}
	if !p.fetchedAt.IsZero() && p.now().Sub(p.fetchedAt) < keysRefreshInterval {
		return nil, errNoKey
	}
	if err := p.refreshKeys(ctx); err != nil {
		return nil, err
	}
	if key, ok := findKey(p.keys, kid, alg); ok {
		return key, nil
	}
	return nil, errNoKey
}

// findKey wants the id and the algorithm to fit. Without an id, a key is only good
// if it is the one possibility.
func findKey(keys []verificationKey, kid, alg string) (crypto.PublicKey, bool) {
	var found crypto.PublicKey
	matches := 0
	for _, k := range keys {
		if k.alg == alg && (kid == "" || k.id == kid) {
			found = k.pub
			matches++
		}
	}
	return found, matches == 1
}

// refreshKeys replaces the keys held. A failure keeps those there are, and counts
// as a fetch, so that an outage is not hammered. The caller holds mu.
func (p *Provider) refreshKeys(ctx context.Context) error {
	p.fetchedAt = p.now()
	var set struct {
		Keys []jwk `json:"keys"`
	}
	if err := getJSON(ctx, p.http, p.meta.JWKSURI, "", &set); err != nil {
		return fmt.Errorf("%w: %w", ErrKeys, err)
	}
	keys := make([]verificationKey, 0, len(set.Keys))
	for _, k := range set.Keys {
		if key, ok := k.parse(); ok {
			keys = append(keys, key)
		}
	}
	p.keys = keys
	return nil
}

// FetchKeys fetches the keys now, for a test of the connection, and returns how
// many this client can use.
func (p *Provider) FetchKeys(ctx context.Context) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.refreshKeys(ctx); err != nil {
		return 0, err
	}
	return len(p.keys), nil
}
