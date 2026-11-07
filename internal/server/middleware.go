package server

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"runtime/debug"
	"strings"
	"time"
)

// bodyDeadline bounds how long a request may take to arrive in full. The
// http.Server only times out the request head, deliberately, because file
// transfers are large and slow links are normal; without a bound on the body,
// a client could open a request and never finish it, holding a goroutine and
// a connection for as long as it likes. A writer that cannot carry a deadline
// (a test recorder) is left alone.
func (s *Server) bodyDeadline(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(s.cfg.BodyTimeout))
		next.ServeHTTP(w, r)
	})
}

// limitBody caps request bodies at Config.MaxBodyBytes. A read past the cap
// fails with *http.MaxBytesError, which the route answers with 413.
func (s *Server) limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
}

// securityHeaders sets the headers that apply to every response.
//
// The Content-Security-Policy is not among them: the web app authors its own
// policy at build time, because only it knows the hashes of the scripts it
// inlines, and the web package serves it with the app shell.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		if s.requestSecure(r) {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if isAPIPath(r.URL.Path) {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// csrf rejects state-changing requests that a browser reports as cross-site. A
// bearer request is exempt: it carries no ambient authority a site could borrow,
// since a browser adds that header only when the calling code knows the token.
func csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if _, bearer := bearerToken(r); !bearer && !sameOrigin(r) {
				writeError(w, http.StatusForbidden, codeForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// bearerToken returns the token of an Authorization: Bearer header.
func bearerToken(r *http.Request) (string, bool) {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" {
		return "", false
	}
	return token, true
}

// sameOrigin reports whether a state-changing request originates from the app
// itself.
//
// Under the Vite dev proxy the browser still talks to a single origin, the dev
// server, which forwards /api to this process; both headers therefore say
// same-origin exactly as they do in production.
func sameOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		return site == "same-origin" || site == "none"
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		return err == nil && u.Host == r.Host
	}
	// Neither header means the request did not come from a browser, so it
	// cannot be a cross-site forgery. Cookies are SameSite=Strict on top.
	return true
}

// logRequests logs one line per request. Bodies and query strings are never
// touched.
func (s *Server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &recorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		s.log.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.statusCode(),
			"bytes", rec.written,
			"duration_ms", time.Since(start).Milliseconds(),
			"remote", s.clientIP(r),
		)
	})
}

// recoverer turns a panic in a handler into a 500 instead of a dropped
// connection, and logs it with a stack trace.
func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			// ErrAbortHandler is the net/http way of aborting a response on
			// purpose; leave it to the server.
			if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
				panic(v)
			}
			s.log.Error("panic",
				"method", r.Method,
				"path", r.URL.Path,
				"panic", v,
				"stack", string(debug.Stack()),
			)
			writeError(w, http.StatusInternalServerError, codeInternal)
		}()
		next.ServeHTTP(w, r)
	})
}

// recorder captures the status code and size of a response for logging.
type recorder struct {
	http.ResponseWriter
	status  int
	written int64
}

func (r *recorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *recorder) Write(b []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(b)
	r.written += int64(n)
	return n, err
}

// Unwrap lets http.NewResponseController reach the underlying writer, so a
// handler wrapped by the logger keeps Flush and the deadline setters.
func (r *recorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *recorder) statusCode() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

func isAPIPath(path string) bool { return strings.HasPrefix(path, "/api/") }

// peerAddr returns the connection's peer address.
func peerAddr(r *http.Request) (host string, addr netip.Addr, ok bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err = netip.ParseAddr(host)
	return host, addr.Unmap(), err == nil
}

// clientIP returns the address a request came from: the connection's peer,
// or, when that peer is a trusted proxy, the address the proxy reports.
//
// X-Forwarded-For is only believed from a trusted proxy, and only its last
// entry, the one that proxy appended: everything before it is whatever the
// client chose to send.
func (s *Server) clientIP(r *http.Request) string {
	host, peer, ok := peerAddr(r)
	if !ok || !s.trustedProxy(peer) {
		return host
	}
	forwarded := r.Header.Get("X-Forwarded-For")
	if i := strings.LastIndexByte(forwarded, ','); i >= 0 {
		forwarded = forwarded[i+1:]
	}
	client, err := netip.ParseAddr(strings.TrimSpace(forwarded))
	if err != nil {
		return host
	}
	return client.Unmap().WithZone("").String()
}

// rateLimitKey is the address a request counts against. An IPv6 client usually
// controls a whole /64, so counting single addresses would give it as many
// windows as it cares to use. Logs and the audit trail keep the full address.
func (s *Server) rateLimitKey(r *http.Request) string {
	ip := s.clientIP(r)
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return ip
	}
	addr = addr.Unmap().WithZone("")
	if addr.Is4() {
		return addr.String()
	}
	prefix, err := addr.Prefix(64)
	if err != nil {
		return ip
	}
	return prefix.String()
}

// requestSecure reports whether the request reached the user over HTTPS,
// according to Config.Secure. In auto mode that is the connection's own TLS
// state, or the X-Forwarded-Proto a trusted proxy reports.
func (s *Server) requestSecure(r *http.Request) bool {
	switch s.cfg.Secure {
	case SecureAlways:
		return true
	case SecureNever:
		return false
	}
	if r.TLS != nil {
		return true
	}
	_, peer, ok := peerAddr(r)
	if !ok || !s.trustedProxy(peer) {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

func (s *Server) trustedProxy(addr netip.Addr) bool {
	for _, p := range s.cfg.TrustedProxies {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}
