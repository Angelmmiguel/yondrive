// Package server exposes YonDrive's HTTP API and, optionally, the embedded web
// app. It never inspects the content it stores.
package server

import (
	"log/slog"
	"net/http"
	"net/netip"
	"time"
)

// Defaults for Config.
const (
	// DefaultBodyTimeout is how long a request may take to arrive in full.
	DefaultBodyTimeout = 2 * time.Minute
	// DefaultMaxBodyBytes is the largest request body a route accepts unless
	// it raises the limit itself.
	DefaultMaxBodyBytes = 1 << 20
)

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
	// SetupComplete reports whether the first-run setup has been completed.
	// Nil means it has not.
	SetupComplete func() bool
	// UI serves the web app. Nil disables it and every non-API path 404s.
	UI http.Handler
	// Logger receives request and error logs. Nil uses slog.Default.
	Logger *slog.Logger
}

// Server is the HTTP handler for the YonDrive API.
type Server struct {
	cfg     Config
	log     *slog.Logger
	handler http.Handler
}

// New builds a Server and applies Config defaults.
func New(cfg Config) *Server {
	if cfg.Secure == "" {
		cfg.Secure = SecureAuto
	}
	if cfg.BodyTimeout <= 0 {
		cfg.BodyTimeout = DefaultBodyTimeout
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	s := &Server{cfg: cfg, log: cfg.Logger}
	s.handler = s.routes()
	return s
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
