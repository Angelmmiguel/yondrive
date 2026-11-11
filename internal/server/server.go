// Package server exposes YonDrive's HTTP API and, optionally, the embedded web
// app. It never inspects the content it stores.
package server

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/oidc"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Defaults for Config.
const (
	// DefaultBodyTimeout is how long a request may take to arrive in full.
	DefaultBodyTimeout = 2 * time.Minute
	// DefaultMaxBodyBytes is the largest request body a route accepts unless
	// it raises the limit itself.
	DefaultMaxBodyBytes = 1 << 20
	// DefaultFrameTimeout is how long one frame of an upload may take to arrive.
	DefaultFrameTimeout = 5 * time.Minute
	// DefaultUploadTTL is how long an upload may sit untouched before it is
	// dropped and its reservation released.
	DefaultUploadTTL = 7 * 24 * time.Hour
)

// usernameAttemptsFactor is how many times the per-address limit one username
// allows in a window. It catches guessing spread over many addresses. A stranger
// can spend it to refuse a user's sign-ins, so it is high enough to need several
// addresses working at their own limit, and lasts one short window. Sessions
// already open are not affected.
const usernameAttemptsFactor = 5

// kdfAttemptsFactor is how many times the sign-in limit the KDF route allows.
const kdfAttemptsFactor = 6

// lookupAttemptsFactor is how many times the sign-in limit a user or an address
// may look up usernames: enough to share with people, not to walk a dictionary.
const lookupAttemptsFactor = 3

// SecureMode says when the server treats a request as arriving over HTTPS.
type SecureMode string

// The accepted values of YONDRIVE_SECURE.
const (
	// SecureAuto follows the connection's own TLS state, or the
	// X-Forwarded-Proto of a trusted proxy.
	SecureAuto SecureMode = "auto"
	// SecureAlways treats every request as secure.
	SecureAlways SecureMode = "true"
	// SecureNever treats every request as plain HTTP.
	SecureNever SecureMode = "false"
)

// Config configures a Server. The zero value of every size and duration field
// falls back to the corresponding default.
type Config struct {
	// Version is the build version reported by the health route.
	Version string
	// Commit is the git commit of the build, and WebBundle the root hash of the
	// web app it embeds, both reported by the health routes. Empty leaves them out.
	Commit    string
	WebBundle string
	// Secure decides how cookies and HSTS follow the request scheme. The zero
	// value means SecureAuto.
	Secure SecureMode
	// TrustedProxies are the addresses a reverse proxy connects from. Only
	// for a connection from one of them are X-Forwarded-For and
	// X-Forwarded-Proto believed.
	TrustedProxies []netip.Prefix
	// BodyTimeout bounds how long a request may take to arrive in full.
	BodyTimeout time.Duration
	// MaxBodyBytes is the default limit on request bodies.
	MaxBodyBytes int64
	// FrameTimeout bounds how long a frame or small blob may take to arrive.
	FrameTimeout time.Duration
	// UploadTTL is how long an upload may sit untouched.
	UploadTTL time.Duration
	// DataDir is the data directory, shown read-only by the setup wizard.
	DataDir string
	// PublicURL is the address from the environment, offered by the wizard.
	PublicURL string
	// SetupToken is the one-time token that the wizard's calls must carry on
	// an unconfigured server. Empty means setup cannot be completed.
	SetupToken string
	// SessionTTL is how long a session lasts unused; SessionMaxAge how long it
	// lasts however much it is used.
	SessionTTL    time.Duration
	SessionMaxAge time.Duration
	// LoginAttempts and LoginWindow are the per-address rate limit on
	// everything that checks a credential.
	LoginAttempts int
	LoginWindow   time.Duration
	// OIDCRoots are the certificate authorities trusted for an identity provider.
	// Nil uses the system's.
	OIDCRoots *x509.CertPool
	// Now is the clock. Nil uses time.Now.
	Now func() time.Time
	// UI serves the web app. Nil disables it and every non-API path 404s.
	UI http.Handler
	// Logger receives request and error logs. Nil uses slog.Default.
	Logger *slog.Logger
}

// Server is the HTTP handler for the YonDrive API.
type Server struct {
	cfg     Config
	log     *slog.Logger
	store   *store.Store
	files   *blobs.Dir
	limiter *auth.RateLimiter
	// kdfLimiter is apart from limiter: a sign-in takes one lookup too, and an
	// answer from this route proves nothing.
	kdfLimiter      *auth.RateLimiter
	usernameLimiter *auth.RateLimiter
	totpLimiter     *auth.RateLimiter
	lookupLimiter   *auth.RateLimiter
	// A link's password is limited by address and, higher up for the same reason
	// as usernameLimiter, by link. Opening any link is limited by address alone.
	linkPasswordLimiter *auth.RateLimiter
	linkLimiter         *auth.RateLimiter
	linkOpenLimiter     *auth.RateLimiter
	// requestUploadLimiter counts the uploads an address starts through requests.
	requestUploadLimiter *auth.RateLimiter
	// pairingLimiter counts the claims and polls of devices being added, by address.
	pairingLimiter *auth.RateLimiter
	// linkTokenKey signs link tokens.
	linkTokenKey []byte
	keys         *auth.SessionKeys
	// secret keys the fake KDF parameters.
	secret  []byte
	handler http.Handler

	// oidcHTTP is the one client that talks to identity providers, oidcFlowKey
	// seals the state of a sign-in, and providers holds the discovered provider.
	oidcHTTP    *http.Client
	oidcFlowKey []byte
	providers   providerCache
	// recent holds the sessions a fresh sign-in through the provider made.
	recent recentSignIns

	// frames keeps two writers off the same frame.
	frames *frameLocks
	// sweepMu keeps one sweep at a time, and drainMu one pass over the file
	// removals, which requests also start.
	sweepMu sync.Mutex
	drainMu sync.Mutex

	// mode is nil until setup completes. It never changes after that, and the
	// advisory lock on the data directory means no other process can set it.
	mode atomic.Pointer[api.Mode]

	// accountMu serialises what reads a credential and acts on it: setup,
	// login, rekey and disabling a user. A session must never be opened on a
	// credential that has just been retired.
	accountMu sync.Mutex
	// setupHash is the hash of the setup token, nil once burnt. Guarded by
	// accountMu.
	setupHash []byte
}

// New builds a Server over st and applies Config defaults.
func New(cfg Config, st *store.Store) (*Server, error) {
	if cfg.Secure == "" {
		cfg.Secure = SecureAuto
	}
	if cfg.BodyTimeout <= 0 {
		cfg.BodyTimeout = DefaultBodyTimeout
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if cfg.FrameTimeout <= 0 {
		cfg.FrameTimeout = DefaultFrameTimeout
	}
	if cfg.UploadTTL <= 0 {
		cfg.UploadTTL = DefaultUploadTTL
	}
	if cfg.SessionTTL <= 0 {
		cfg.SessionTTL = auth.DefaultSessionTTL
	}
	if cfg.SessionMaxAge <= 0 {
		cfg.SessionMaxAge = auth.DefaultSessionMaxAge
	}
	if cfg.LoginAttempts <= 0 {
		cfg.LoginAttempts = auth.DefaultLoginAttempts
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	secret, err := st.ServerSecret(context.Background())
	if err != nil {
		return nil, fmt.Errorf("server: read secret: %w", err)
	}
	files, err := blobs.Open(st.Dir())
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:                  cfg,
		log:                  cfg.Logger,
		store:                st,
		files:                files,
		frames:               newFrameLocks(),
		limiter:              auth.NewRateLimiter(cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		kdfLimiter:           auth.NewRateLimiter(kdfAttemptsFactor*cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		usernameLimiter:      auth.NewRateLimiter(usernameAttemptsFactor*cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		totpLimiter:          auth.NewRateLimiter(totpAttemptsPerWindow, cfg.LoginWindow, cfg.Now),
		lookupLimiter:        auth.NewRateLimiter(lookupAttemptsFactor*cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		linkPasswordLimiter:  auth.NewRateLimiter(cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		linkLimiter:          auth.NewRateLimiter(usernameAttemptsFactor*cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		linkOpenLimiter:      auth.NewRateLimiter(kdfAttemptsFactor*cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		requestUploadLimiter: auth.NewRateLimiter(requestUploadAttemptsFactor*cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		pairingLimiter:       auth.NewRateLimiter(pairingAttemptsFactor*cfg.LoginAttempts, cfg.LoginWindow, cfg.Now),
		linkTokenKey:         deriveLinkTokenKey(secret),
		keys:                 auth.NewSessionKeys(),
		secret:               secret,
		oidcHTTP:             oidc.NewHTTPClient(cfg.OIDCRoots),
		oidcFlowKey:          deriveOIDCFlowKey(secret),
	}
	settings, err := st.Settings(context.Background())
	switch {
	case err == nil:
		mode := api.Mode(settings.Mode)
		s.mode.Store(&mode)
	case errors.Is(err, store.ErrNotConfigured):
		if cfg.SetupToken != "" {
			s.setupHash = auth.HashToken(cfg.SetupToken)
		}
	default:
		return nil, fmt.Errorf("server: read settings: %w", err)
	}
	if err := s.reconcileFiles(context.Background()); err != nil {
		return nil, err
	}
	s.handler = s.routes()
	return s, nil
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	s.apiHandler(mux)

	// Unknown API paths answer in JSON instead of falling through to the app.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, codeNotFound)
	})

	if s.cfg.UI != nil {
		mux.Handle("/", s.cfg.UI)
	} else {
		mux.HandleFunc("/", http.NotFound)
	}

	return s.recoverer(s.logRequests(s.bodyDeadline(s.securityHeaders(csrf(s.limitBody(mux))))))
}
