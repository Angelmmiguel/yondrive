package server

import (
	"context"
	"net/http"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
)

// access says who may call an operation.
type access int

const (
	// accessUser, the zero value, is what an operation not listed gets: it
	// cannot become public by being forgotten.
	accessUser access = iota
	// accessPublic is open to anyone, whatever the state of the server.
	accessPublic
	// accessSetup needs the setup token, on a server not yet configured.
	accessSetup
)

// operationAccess lists every operation that does not need a signed-in user.
var operationAccess = map[string]access{
	"GetHealth":        accessPublic,
	"GetOpenAPISpec":   accessPublic,
	"GetSetupInfo":     accessSetup,
	"ValidateSetupURL": accessSetup,
	"CompleteSetup":    accessSetup,
}

type requestKey struct{}

// guard enforces operationAccess before a handler runs, and makes the request
// available to it.
func (s *Server) guard(next oapi.StrictHandlerFunc, operation string) oapi.StrictHandlerFunc {
	level := operationAccess[operation]
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
		ctx = context.WithValue(ctx, requestKey{}, r)
		switch level {
		case accessPublic:
		case accessSetup:
			if err := s.checkSetupToken(r); err != nil {
				return nil, err
			}
		case accessUser:
			return nil, fail(http.StatusUnauthorized, "unauthorized")
		}
		return next(ctx, w, r, request)
	}
}

// checkSetupToken answers already_setup on a configured server, whatever the
// token, and otherwise compares it in constant time. Only wrong tokens count
// against the address: the wizard calls these routes freely, and the token
// itself is far beyond guessing.
func (s *Server) checkSetupToken(r *http.Request) error {
	s.accountMu.Lock()
	hash := s.setupHash
	s.accountMu.Unlock()
	if s.mode.Load() != nil {
		return fail(http.StatusConflict, codeAlreadySetup)
	}
	if hash != nil && auth.TokenMatches(r.Header.Get("X-Setup-Token"), hash) {
		return nil
	}
	s.log.Warn("setup token rejected", "remote", s.clientIP(r))
	if !s.limiter.Allow(s.clientIP(r)) {
		return fail(http.StatusTooManyRequests, codeRateLimited)
	}
	return fail(http.StatusUnauthorized, codeSetupTokenInvalid)
}

// clientAddr returns the caller's address, from the request guard stored.
func (s *Server) clientAddr(ctx context.Context) string {
	if r, ok := ctx.Value(requestKey{}).(*http.Request); ok {
		return s.clientIP(r)
	}
	return ""
}
