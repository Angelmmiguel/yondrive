package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// The session cookie. Over HTTPS it carries the __Host- prefix, so the browser
// holds it to this host, with Secure and Path=/, and refuses one set by a sibling
// subdomain or over plain HTTP. Each name is read only in its own mode: a server
// moved to HTTPS ignores the old cookie, which ends that session.
const (
	sessionCookiePlain  = "yondrive_session"
	sessionCookieSecure = "__Host-yondrive_session"
)

// sessionCookieName is the name of the session cookie for a request.
func (s *Server) sessionCookieName(r *http.Request) string {
	if s.requestSecure(r) {
		return sessionCookieSecure
	}
	return sessionCookiePlain
}

// sessionTouchInterval is how stale a session's idle deadline may get before a
// request moves it: often enough for the deadline to stay meaningful, rarely
// enough that reads do not all become writes.
const sessionTouchInterval = time.Minute

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
	// accessOpen is open to anyone, on a configured server.
	accessOpen
	// accessAdmin needs a signed-in admin.
	accessAdmin
	// accessAdminOrSetup needs the setup token before setup, and an admin after it.
	accessAdminOrSetup
)

// operationAccess lists every operation that does not need just a signed-in
// user.
var operationAccess = map[string]access{
	"GetHealth":             accessPublic,
	"GetOpenAPISpec":        accessPublic,
	"GetSetupInfo":          accessSetup,
	"ValidateSetupURL":      accessSetup,
	"CompleteSetup":         accessSetup,
	"GetKDF":                accessOpen,
	"Login":                 accessOpen,
	"Register":              accessOpen,
	"GetAuthMethods":        accessOpen,
	"StartOIDC":             accessOpen,
	"StartOIDCWithInvite":   accessOpen,
	"FinishOIDC":            accessOpen,
	"TestOIDC":              accessAdminOrSetup,
	"UnlinkIdentity":        accessAdmin,
	"CompletePasswordReset": accessOpen,
	"GetPublicLink":         accessOpen,
	"UnlockPublicLink":      accessOpen,
	"GetPublicNode":         accessOpen,
	"ListPublicChildren":    accessOpen,
	"GetPublicVersion":      accessOpen,
	"GetPublicBlob":         accessOpen,
	"GetPublicRequest":      accessOpen,
	"UnlockPublicRequest":   accessOpen,
	"CreateRequestUpload":   accessOpen,
	"GetRequestUpload":      accessOpen,
	"AbortRequestUpload":    accessOpen,
	"PutRequestFrame":       accessOpen,
	"CommitRequestUpload":   accessOpen,
	"ListInvites":           accessAdmin,
	"CreateInvite":          accessAdmin,
	"DeleteInvite":          accessAdmin,
	"ListUsers":             accessAdmin,
	"UpdateUser":            accessAdmin,
	"DeleteUser":            accessAdmin,
	"CreatePasswordReset":   accessAdmin,
	"GetSettings":           accessAdmin,
	"UpdateSettings":        accessAdmin,
	"GetAdminHealth":        accessAdmin,
	"ListAudit":             accessAdmin,
}

type (
	requestKey   struct{}
	principalKey struct{}
)

// principal is who a request acts as.
type principal struct {
	user store.User
	// sessionHash names the session the request came through, if it did.
	sessionHash []byte
	// tokenID names the bearer token it came through, if it did.
	tokenID string
}

// guard enforces operationAccess before a handler runs, and makes the request
// and the principal available to it.
func (s *Server) guard(next oapi.StrictHandlerFunc, operation string) oapi.StrictHandlerFunc {
	level := operationAccess[operation]
	return func(ctx context.Context, w http.ResponseWriter, r *http.Request, request any) (any, error) {
		ctx = context.WithValue(ctx, requestKey{}, r)
		level := level
		if level == accessAdminOrSetup {
			level = accessAdmin
			if s.mode.Load() == nil {
				level = accessSetup
			}
		}
		switch level {
		case accessPublic:
		case accessSetup:
			if err := s.checkSetupToken(r); err != nil {
				return nil, err
			}
		case accessOpen:
			if s.mode.Load() == nil {
				return nil, fail(http.StatusConflict, codeNotSetup)
			}
		case accessUser, accessAdmin:
			p, err := s.authenticate(ctx, r)
			if err != nil {
				return nil, err
			}
			if level == accessAdmin && p.user.Role != string(oapi.Admin) {
				return nil, fail(http.StatusForbidden, codeForbidden)
			}
			ctx = context.WithValue(ctx, principalKey{}, p)
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
	if !s.limiter.Allow(s.rateLimitKey(r)) {
		return fail(http.StatusTooManyRequests, codeRateLimited)
	}
	return fail(http.StatusUnauthorized, codeSetupTokenInvalid)
}

var errUnauthorized = fail(http.StatusUnauthorized, codeUnauthorized)

// authenticate resolves a request to a principal. An Authorization header takes
// over from any cookie: csrf lets bearer requests through, and it must not
// thereby let through one that acts on the cookie.
func (s *Server) authenticate(ctx context.Context, r *http.Request) (principal, error) {
	if r.Header.Get("Authorization") != "" {
		return s.authenticateBearer(ctx, r)
	}
	return s.authenticateSession(ctx, r)
}

// authenticateBearer resolves a device token.
func (s *Server) authenticateBearer(ctx context.Context, r *http.Request) (principal, error) {
	secret, ok := bearerToken(r)
	if !ok {
		return principal{}, errUnauthorized
	}
	token, err := s.store.TokenByHash(ctx, auth.HashToken(secret))
	if errors.Is(err, store.ErrNotFound) {
		return principal{}, errUnauthorized
	}
	if err != nil {
		return principal{}, err
	}
	user, err := s.activeUser(ctx, token.UserID)
	if err != nil {
		return principal{}, err
	}
	now := s.cfg.Now()
	if now.Sub(token.LastUsedAt) >= sessionTouchInterval {
		if err := s.store.TouchToken(ctx, token.ID, now); err != nil {
			s.log.Error("token use not recorded", "error", err)
		}
	}
	return principal{user: user, tokenID: token.ID}, nil
}

// authenticateSession resolves the session cookie, ending the session if a
// deadline has passed and extending its idle window otherwise.
func (s *Server) authenticateSession(ctx context.Context, r *http.Request) (principal, error) {
	c, err := r.Cookie(s.sessionCookieName(r))
	if err != nil {
		return principal{}, errUnauthorized
	}
	hash := auth.HashToken(c.Value)
	sess, err := s.store.SessionByHash(ctx, hash)
	if errors.Is(err, store.ErrNotFound) {
		return principal{}, errUnauthorized
	}
	if err != nil {
		return principal{}, err
	}
	now := s.cfg.Now()
	if !now.Before(sess.ExpiresAt) || !now.Before(sess.AbsoluteAt) {
		if err := s.store.DeleteSession(ctx, hash); err != nil {
			return principal{}, err
		}
		s.keys.Drop(hash)
		return principal{}, errUnauthorized
	}
	user, err := s.activeUser(ctx, sess.UserID)
	if err != nil {
		return principal{}, err
	}
	next := now.Add(s.cfg.SessionTTL)
	if next.After(sess.AbsoluteAt) {
		next = sess.AbsoluteAt
	}
	if next.Sub(sess.ExpiresAt) >= sessionTouchInterval {
		if err := s.store.TouchSession(ctx, hash, next); err != nil {
			s.log.Error("session not extended", "error", err)
		}
	}
	return principal{user: user, sessionHash: hash}, nil
}

// activeUser loads the user behind a session or token. Disabling a user ends
// those, so this only matters for a request already in flight.
func (s *Server) activeUser(ctx context.Context, id string) (store.User, error) {
	user, err := s.store.UserByID(ctx, id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && user.Disabled) {
		return store.User{}, errUnauthorized
	}
	return user, err
}

// sessionCookieHeader returns the Set-Cookie value for a token. An empty token
// clears the cookie.
func (s *Server) sessionCookieHeader(ctx context.Context, token string) *string {
	r := requestFrom(ctx)
	c := http.Cookie{ //nolint:gosec // Secure follows YONDRIVE_SECURE: plain HTTP is a supported setup
		Name:     s.sessionCookieName(r),
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.requestSecure(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(s.cfg.SessionMaxAge.Seconds()),
	}
	if token == "" {
		c.MaxAge = -1
	}
	v := c.String()
	return &v
}

func requestFrom(ctx context.Context) *http.Request {
	r, _ := ctx.Value(requestKey{}).(*http.Request)
	return r
}

func principalFrom(ctx context.Context) principal {
	p, _ := ctx.Value(principalKey{}).(principal)
	return p
}

// checkAttempt counts an attempt at a credential against the caller's address.
// Every attempt counts, not only failures, so that guessing cannot hide behind
// valid sign-ins.
func (s *Server) checkAttempt(ctx context.Context) error {
	if !s.limiter.Allow(s.rateLimitKey(requestFrom(ctx))) {
		return fail(http.StatusTooManyRequests, codeRateLimited)
	}
	return nil
}

// audit records a security event. A failed write is logged and does not undo
// what already happened.
func (s *Server) audit(ctx context.Context, action, actorID, targetID string) {
	err := s.store.AppendAudit(context.WithoutCancel(ctx), store.AuditEntry{
		At:       s.cfg.Now(),
		Action:   action,
		ActorID:  actorID,
		TargetID: targetID,
		Remote:   s.clientIP(requestFrom(ctx)),
	})
	if err != nil {
		s.log.Error("audit write failed", "action", action, "error", err)
	}
}

// PurgeExpiredSessions ends sessions past a deadline, and wipes their keys, once
// per interval until ctx is done. Without it, a key would stay in memory until
// someone happened to present the expired cookie.
func (s *Server) PurgeExpiredSessions(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			hashes, err := s.store.DeleteExpiredSessions(ctx, s.cfg.Now())
			if err != nil {
				s.log.Error("session purge failed", "error", err)
				continue
			}
			s.keys.Drop(hashes...)
		}
	}
}
