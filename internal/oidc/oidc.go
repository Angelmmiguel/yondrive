// Package oidc is the relying party of OpenID Connect's authorization code flow:
// discovery, PKCE, the code exchange, and the verification of ID tokens against
// the provider's published keys. It holds no state about users and no HTTP
// handlers. Its errors never carry a token, a code or a response body, so that a
// caller can log them.
package oidc

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Bounds of what the server does for a provider.
const (
	requestTimeout   = 10 * time.Second
	dialTimeout      = 5 * time.Second
	maxResponseBytes = 1 << 20
	maxRedirects     = 3
	maxIssuerLen     = 2048
	// keysRefreshInterval is how often an unknown key id may fetch the keys again:
	// often enough for a rotation at the provider to take effect at once, and
	// rarely enough that forged ids cannot turn this server into a flood.
	keysRefreshInterval = time.Minute
)

// Errors of talking to a provider. Callers match them with errors.Is.
var (
	// ErrInvalidIssuer means the address cannot be an issuer, or needs the
	// allow-insecure setting.
	ErrInvalidIssuer = errors.New("oidc: issuer is not a usable address")
	// ErrDiscovery means the provider's configuration could not be fetched, or does
	// not support what this client needs.
	ErrDiscovery = errors.New("oidc: discovery failed")
	// ErrIssuerMismatch means the configuration names another issuer.
	ErrIssuerMismatch = errors.New("oidc: configuration names another issuer")
	// ErrKeys means the provider's keys could not be fetched.
	ErrKeys = errors.New("oidc: keys not available")
	// ErrExchange means the token endpoint refused the code or could not be reached.
	ErrExchange = errors.New("oidc: code exchange failed")
	// ErrUserInfo means the userinfo endpoint failed, or answered for someone else.
	ErrUserInfo = errors.New("oidc: userinfo failed")
	// ErrAddress means a connection was refused because of where it leads.
	ErrAddress = errors.New("oidc: address not allowed")
	// ErrRedirect means the provider redirected somewhere this client does not follow.
	ErrRedirect = errors.New("oidc: redirect not followed")
)

// Client authentication at the token endpoint.
const (
	authBasic = "client_secret_basic"
	authPost  = "client_secret_post"
)

// NewHTTPClient returns the client every call to a provider goes through. It has
// a timeout and no use of proxy variables, follows redirects only on one host,
// and refuses link-local addresses: the issuer is a URL an admin typed, and a
// host's metadata service is not an identity provider. Private addresses stay
// allowed, as an identity provider on the LAN is the normal case here. A nil
// roots uses the system's certificate authorities.
func NewHTTPClient(roots *x509.CertPool) *http.Client {
	dialer := &net.Dialer{Timeout: dialTimeout, Control: refuseAddress}
	return &http.Client{
		Timeout: requestTimeout,
		Transport: &http.Transport{
			DialContext:            dialer.DialContext,
			TLSClientConfig:        &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12},
			TLSHandshakeTimeout:    dialTimeout,
			ResponseHeaderTimeout:  requestTimeout,
			MaxResponseHeaderBytes: 64 << 10,
			IdleConnTimeout:        time.Minute,
			MaxIdleConns:           4,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			first := via[0].URL
			if len(via) >= maxRedirects || req.URL.Host != first.Host || (first.Scheme == "https" && req.URL.Scheme != "https") {
				return ErrRedirect
			}
			return nil
		},
	}
}

// refuseAddress sees the address actually dialled, after name resolution, so a
// name that resolves differently the second time gets no further.
func refuseAddress(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return ErrAddress
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return ErrAddress
	}
	ip = ip.Unmap()
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return ErrAddress
	}
	return nil
}

// LoadRoots returns the system's certificate authorities plus those of a PEM file,
// for an issuer behind an internal authority. An empty path returns nil, which
// means the system's alone.
func LoadRoots(path string) (*x509.CertPool, error) {
	if path == "" {
		return nil, nil
	}
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("oidc: read certificate authorities: %w", err)
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if !roots.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("oidc: %s holds no certificates", path)
	}
	return roots, nil
}

// CheckIssuer reports whether an address can be an issuer: https, or http with
// the allow-insecure setting, with a host and no credentials, query or fragment.
// The issuer is compared character for character, so nothing here normalises it.
func CheckIssuer(issuer string, allowInsecure bool) error {
	if len(issuer) > maxIssuerLen {
		return ErrInvalidIssuer
	}
	u, err := url.Parse(issuer)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return ErrInvalidIssuer
	}
	return checkScheme(u, allowInsecure, ErrInvalidIssuer)
}

func checkScheme(u *url.URL, allowInsecure bool, failure error) error {
	if u.Scheme == "https" || (u.Scheme == "http" && allowInsecure) {
		return nil
	}
	return failure
}

// Metadata is what discovery says about a provider.
type Metadata struct {
	Issuer                string   `json:"issuer"`
	AuthorizationEndpoint string   `json:"authorization_endpoint"`
	TokenEndpoint         string   `json:"token_endpoint"`
	UserinfoEndpoint      string   `json:"userinfo_endpoint"`
	JWKSURI               string   `json:"jwks_uri"`
	ResponseTypes         []string `json:"response_types_supported"`
	CodeChallengeMethods  []string `json:"code_challenge_methods_supported"`
	TokenAuthMethods      []string `json:"token_endpoint_auth_methods_supported"`
	SigningAlgs           []string `json:"id_token_signing_alg_values_supported"`
}

// Provider is an issuer after discovery. It caches the issuer's keys, and is safe
// for concurrent use.
type Provider struct {
	meta       Metadata
	authMethod string
	http       *http.Client
	now        func() time.Time

	mu        sync.Mutex
	keys      []verificationKey
	fetchedAt time.Time
}

// Discover fetches and checks an issuer's configuration. The issuer in the
// document must equal the one configured, character for character, which is what
// makes the document the issuer's own. Every endpoint is held to the issuer's
// rule on schemes, so that a plain endpoint cannot carry a client secret. now is
// the clock of the key cache and of token verification.
func Discover(ctx context.Context, hc *http.Client, issuer string, allowInsecure bool, now func() time.Time) (*Provider, error) {
	if err := CheckIssuer(issuer, allowInsecure); err != nil {
		return nil, err
	}
	var meta Metadata
	if err := getJSON(ctx, hc, strings.TrimSuffix(issuer, "/")+"/.well-known/openid-configuration", "", &meta); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrDiscovery, err)
	}
	if meta.Issuer != issuer {
		return nil, ErrIssuerMismatch
	}
	endpoints := []string{meta.AuthorizationEndpoint, meta.TokenEndpoint, meta.JWKSURI}
	if meta.UserinfoEndpoint != "" {
		endpoints = append(endpoints, meta.UserinfoEndpoint)
	}
	for _, e := range endpoints {
		u, err := url.Parse(e)
		if err != nil || u.Host == "" || checkScheme(u, allowInsecure, ErrDiscovery) != nil {
			return nil, fmt.Errorf("%w: unusable endpoint", ErrDiscovery)
		}
	}
	if len(meta.ResponseTypes) > 0 && !slices.Contains(meta.ResponseTypes, "code") {
		return nil, fmt.Errorf("%w: no authorization code flow", ErrDiscovery)
	}
	if len(meta.CodeChallengeMethods) > 0 && !slices.Contains(meta.CodeChallengeMethods, "S256") {
		return nil, fmt.Errorf("%w: no S256 PKCE", ErrDiscovery)
	}
	method, err := chooseAuthMethod(meta.TokenAuthMethods)
	if err != nil {
		return nil, err
	}
	return &Provider{meta: meta, authMethod: method, http: hc, now: now}, nil
}

// chooseAuthMethod follows the provider's list, whose absence means basic.
func chooseAuthMethod(supported []string) (string, error) {
	switch {
	case len(supported) == 0, slices.Contains(supported, authBasic):
		return authBasic, nil
	case slices.Contains(supported, authPost):
		return authPost, nil
	}
	return "", fmt.Errorf("%w: no client secret method", ErrDiscovery)
}

// Metadata returns the provider's configuration.
func (p *Provider) Metadata() Metadata { return p.meta }

// TokenAuthMethod names how this client will authenticate at the token endpoint.
func (p *Provider) TokenAuthMethod() string { return p.authMethod }

// getJSON fetches a document into out. Anything but a 200 of bounded size is a
// failure, and the body of a failure is not read.
func getJSON(ctx context.Context, hc *http.Client, target, bearer string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	return doJSON(hc, req, out)
}

func doJSON(hc *http.Client, req *http.Request, out any) error {
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("request to %s: %w", req.URL.Host, redact(err))
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d from %s", resp.StatusCode, req.URL.Host)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read from %s: %w", req.URL.Host, redact(err))
	}
	if len(body) > maxResponseBytes {
		return fmt.Errorf("response from %s too large", req.URL.Host)
	}
	// The body may hold tokens, and json errors quote what they stumble on.
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("malformed response from %s", req.URL.Host)
	}
	return nil
}

// redact drops the URL an http.Client puts in its errors, which for an endpoint
// with a query could say more than it should.
func redact(err error) error {
	var u *url.Error
	if errors.As(err, &u) {
		return u.Err
	}
	return err
}
