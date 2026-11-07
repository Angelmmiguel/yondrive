package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/oidc"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// oidcCallbackPath is what the public URL is followed by in the redirect URI.
const oidcCallbackPath = "/auth/oidc/callback"

// Where a browser ends up after signing in through a provider. No token is in either:
// the session is a cookie, and the app asks GET /me what comes next.
const (
	oidcSuccessPath = "/"
	oidcFailurePath = "/signin?sso_error="
)

// The flow cookie. __Host- makes the browser hold it to one host and refuse it from a
// sibling subdomain, which it can only do over HTTPS.
const (
	flowCookiePlain  = "yondrive_oidc_flow"
	flowCookieSecure = "__Host-yondrive_oidc_flow"
)

const (
	// providerTTL is how long a discovery document is believed.
	providerTTL = time.Hour
	// reauthWindow is how recent a sign-in through the provider has to be to stand in
	// for a current credential, for an account with no credential of its own.
	reauthWindow = 5 * time.Minute

	maxClientIDLen     = 256
	maxClientSecretLen = 1024
	maxClaimLen        = 128
	maxUsernameBaseLen = 58
	maxUsernameTries   = 20
)

// Audit actions of signing in through a provider.
const (
	auditSSOSucceeded = "sso_login_succeeded"
	auditSSOFailed    = "sso_login_failed"
	auditSSOLinked    = "sso_identity_linked"
	auditSSOUnlinked  = "sso_identity_unlinked"
	auditSSOCreated   = "sso_user_created"
	auditSSOEnrolled  = "sso_keys_enrolled"
	auditSSOPromoted  = "sso_role_granted"
	auditSSODemoted   = "sso_role_revoked"
)

var scopesPattern = regexp.MustCompile(`^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$`)

func deriveOIDCFlowKey(secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("yondrive/oidc-flow-key/v1"))
	return mac.Sum(nil)
}

// providerCache holds the provider of the current settings.
type providerCache struct {
	mu       sync.Mutex
	provider *oidc.Provider
	issuer   string
	insecure bool
	at       time.Time
}

// provider returns the configured provider, discovering it when it is not known or
// has been known for long enough.
func (s *Server) provider(ctx context.Context, o store.OIDCSettings) (*oidc.Provider, error) {
	c := &s.providers
	c.mu.Lock()
	defer c.mu.Unlock()
	now := s.cfg.Now()
	if c.provider != nil && c.issuer == o.Issuer && c.insecure == o.AllowInsecure && now.Sub(c.at) < providerTTL {
		return c.provider, nil
	}
	p, err := oidc.Discover(ctx, s.oidcHTTP, o.Issuer, o.AllowInsecure, s.cfg.Now)
	if err != nil {
		return nil, err
	}
	c.provider, c.issuer, c.insecure, c.at = p, o.Issuer, o.AllowInsecure, now
	return p, nil
}

func oidcClient(settings store.Settings) oidc.Client {
	return oidc.Client{
		ID:          settings.OIDC.ClientID,
		Secret:      settings.OIDC.ClientSecret,
		RedirectURI: settings.PublicURL + oidcCallbackPath,
		Scopes:      settings.OIDC.Scopes,
	}
}

func oidcSettingsView(in store.Settings) *oapi.OIDCSettings {
	o := in.OIDC
	return &oapi.OIDCSettings{
		Enabled:         o.Enabled,
		Label:           o.Label,
		Issuer:          o.Issuer,
		ClientId:        o.ClientID,
		ClientSecretSet: o.ClientSecret != "",
		Scopes:          o.Scopes,
		AdminGroup:      o.AdminGroup,
		AdminClaim:      o.AdminClaim,
		MatchMode:       oapi.OIDCMatchMode(o.MatchMode),
		NewUsers:        oapi.OIDCNewUsers(o.NewUsers),
		AllowInsecure:   o.AllowInsecure,
		RedirectUri:     in.PublicURL + oidcCallbackPath,
	}
}

func set[T any](dst *T, v *T) {
	if v != nil {
		*dst = *v
	}
}

// mergeOIDCSettings applies a change and checks the result as a whole.
func mergeOIDCSettings(cur store.OIDCSettings, in oapi.OIDCSettingsInput) (store.OIDCSettings, error) {
	set(&cur.Enabled, in.Enabled)
	set(&cur.Label, in.Label)
	set(&cur.ClientID, in.ClientId)
	// A form left blank means no change, and is no way to clear the secret by accident.
	if in.ClientSecret != nil && *in.ClientSecret != "" {
		cur.ClientSecret = *in.ClientSecret
	}
	set(&cur.Scopes, in.Scopes)
	set(&cur.AdminGroup, in.AdminGroup)
	set(&cur.AdminClaim, in.AdminClaim)
	set(&cur.AllowInsecure, in.AllowInsecure)
	if in.Issuer != nil {
		cur.Issuer = strings.TrimSpace(*in.Issuer)
	}
	if in.MatchMode != nil {
		cur.MatchMode = string(*in.MatchMode)
	}
	if in.NewUsers != nil {
		cur.NewUsers = string(*in.NewUsers)
	}
	if cur.Issuer != "" && oidc.CheckIssuer(cur.Issuer, cur.AllowInsecure) != nil {
		return cur, badRequest(codeInvalidIssuer)
	}
	if !validOIDCSettings(cur) {
		return cur, badRequest(codeInvalidOIDC)
	}
	return cur, nil
}

func validOIDCSettings(o store.OIDCSettings) bool {
	if !validName(o.Label) || !scopesPattern.MatchString(o.Scopes) || !slices.Contains(strings.Fields(o.Scopes), "openid") {
		return false
	}
	if !slices.Contains([]string{store.MatchEmail, store.MatchUsername, store.MatchSubject}, o.MatchMode) ||
		!slices.Contains([]string{store.NewUsersCreate, store.NewUsersInvited}, o.NewUsers) {
		return false
	}
	for _, field := range []struct {
		value string
		limit int
	}{{o.ClientID, maxClientIDLen}, {o.ClientSecret, maxClientSecretLen}, {o.AdminGroup, maxClaimLen}, {o.AdminClaim, maxClaimLen}} {
		if len(field.value) > field.limit || !utf8.ValidString(field.value) || strings.ContainsFunc(field.value, isControl) {
			return false
		}
	}
	if o.AdminGroup != "" && o.AdminClaim == "" {
		return false
	}
	return !o.Enabled || (o.Issuer != "" && o.ClientID != "" && o.ClientSecret != "")
}

func isControl(r rune) bool { return r < 0x20 || r == 0x7f }

// signInPatch checks a change to how people sign in, and returns the provider's
// settings to store, if they change.
func (s *Server) signInPatch(ctx context.Context, in *oapi.UpdateSettingsJSONRequestBody) (*store.OIDCSettings, error) {
	if in.Oidc == nil && in.LocalAccounts == nil {
		return nil, nil
	}
	current, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	o := current.OIDC
	var patch *store.OIDCSettings
	if in.Oidc != nil {
		if o, err = mergeOIDCSettings(o, *in.Oidc); err != nil {
			return nil, err
		}
		patch = &o
	}
	local := current.LocalAccounts
	set(&local, in.LocalAccounts)
	if !local {
		admins, err := s.store.LocalAdmins(ctx)
		if err != nil {
			return nil, err
		}
		if !o.Enabled || len(admins) == 0 {
			return nil, fail(http.StatusConflict, codeLocalLockout)
		}
	}
	return patch, nil
}

// checkKeepsLocalAdmin refuses to remove the last local admin while local accounts
// are off: they are the way back in when the provider is down. The caller holds
// accountMu.
func (s *Server) checkKeepsLocalAdmin(ctx context.Context, target string) error {
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return err
	}
	if settings.LocalAccounts {
		return nil
	}
	admins, err := s.store.LocalAdmins(ctx)
	if err != nil {
		return err
	}
	if len(admins) == 1 && admins[0] == target {
		return fail(http.StatusConflict, codeLocalLockout)
	}
	return nil
}

// checkLocalSignIn says whether someone with the right key may use it. Only they get
// to learn this, as the caller has already checked the key.
func (s *Server) checkLocalSignIn(ctx context.Context, user store.User) error {
	if user.SSOOnly() {
		return fail(http.StatusForbidden, codeSSORequired)
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return err
	}
	if settings.LocalAccounts {
		return nil
	}
	admins, err := s.store.LocalAdmins(ctx)
	if err != nil {
		return err
	}
	if len(admins) > 0 && admins[0] == user.ID {
		return nil
	}
	return fail(http.StatusForbidden, codeLocalDisabled)
}

// checkRecentSignIn stands in for a current credential for an account that has none:
// single sign-on in no-encryption mode, which has no passphrase of any kind. A session
// a few minutes old proves the provider has just let this person in, and the client
// can get one with GET /auth/oidc/start?fresh=true. A token is not a sign-in.
func (s *Server) checkRecentSignIn(ctx context.Context, user store.User) error {
	p := principalFrom(ctx)
	if p.sessionHash != nil && s.cfg.Now().Sub(p.sessionCreatedAt) <= reauthWindow {
		return nil
	}
	s.audit(ctx, auditCredentialRejected, user.ID, user.ID)
	return fail(http.StatusUnauthorized, codeReauthRequired)
}

// GetAuthMethods says what the sign-in page should offer.
func (s *Server) GetAuthMethods(ctx context.Context, _ oapi.GetAuthMethodsRequestObject) (oapi.GetAuthMethodsResponseObject, error) {
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	out := oapi.GetAuthMethods200JSONResponse{LocalAccounts: settings.LocalAccounts, OpenSignup: settings.OpenSignup && settings.LocalAccounts}
	if settings.OIDC.Enabled {
		out.Oidc = &struct {
			Label string `json:"label"`
		}{Label: settings.OIDC.Label}
	}
	return out, nil
}

// redirectResponse sends a browser on, with cookies. The generated responses can set
// only one cookie, and the callback sets two.
type redirectResponse struct {
	location string
	cookies  []string
}

func (r redirectResponse) visit(w http.ResponseWriter) error {
	for _, c := range r.cookies {
		w.Header().Add("Set-Cookie", c)
	}
	w.Header().Set("Location", r.location)
	// The callback lives outside /api/, where this is not already set.
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusFound)
	return nil
}

// VisitStartOIDCResponse writes the redirect.
func (r redirectResponse) VisitStartOIDCResponse(w http.ResponseWriter) error { return r.visit(w) }

// VisitFinishOIDCResponse writes the redirect.
func (r redirectResponse) VisitFinishOIDCResponse(w http.ResponseWriter) error { return r.visit(w) }

// flowCookie returns the Set-Cookie value of a sealed flow; empty clears it. It is Lax
// where the session cookie is Strict, because the browser arrives back from another
// site, and a Strict cookie would not come with it. It has no Domain, so it stays on
// this host.
func (s *Server) flowCookie(ctx context.Context, sealed string) string {
	secure := s.requestSecure(requestFrom(ctx))
	name := flowCookiePlain
	if secure {
		name = flowCookieSecure
	}
	c := http.Cookie{ //nolint:gosec // Secure follows YONDRIVE_SECURE: plain HTTP is a supported setup
		Name:     name,
		Value:    sealed,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(oidc.FlowTTL.Seconds()),
	}
	if sealed == "" {
		c.MaxAge = -1
	}
	return c.String()
}

// ssoFailure turns what stopped a sign-in into a redirect the app can show. Details go
// to the log, and the browser gets a stable code.
func (s *Server) ssoFailure(ctx context.Context, err error, cookies ...string) (redirectResponse, error) {
	code := ssoErrorCode(err)
	if code == "" {
		s.log.Error("sign-in through the provider failed", "error", err)
		code = codeInternal
	} else {
		s.log.Warn("sign-in through the provider refused", "code", code, "error", err, "remote", s.clientIP(requestFrom(ctx)))
	}
	s.audit(ctx, auditSSOFailed, "", "")
	return redirectResponse{location: oidcFailurePath + url.QueryEscape(code), cookies: cookies}, nil
}

// ssoErrorCode names a failure, or returns nothing for one that is not expected.
func ssoErrorCode(err error) string {
	var api *apiError
	switch {
	case errors.As(err, &api):
		return api.code
	case errors.Is(err, oidc.ErrToken):
		return codeSSOToken
	case errors.Is(err, oidc.ErrDiscovery), errors.Is(err, oidc.ErrIssuerMismatch), errors.Is(err, oidc.ErrInvalidIssuer),
		errors.Is(err, oidc.ErrExchange), errors.Is(err, oidc.ErrKeys), errors.Is(err, oidc.ErrUserInfo):
		return codeSSOProvider
	}
	return ""
}

// beginFlow prepares to leave for the provider, returning where to and the cookie
// that lets this browser come back.
func (s *Server) beginFlow(ctx context.Context, inviteID string, fresh bool) (target, cookie string, err error) {
	if !s.kdfLimiter.Allow(s.rateLimitKey(requestFrom(ctx))) {
		return "", "", fail(http.StatusTooManyRequests, codeRateLimited)
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return "", "", err
	}
	if !settings.OIDC.Enabled {
		return "", "", fail(http.StatusConflict, codeSSODisabled)
	}
	provider, err := s.provider(ctx, settings.OIDC)
	if err != nil {
		s.log.Warn("identity provider not available", "error", err)
		return "", "", fail(http.StatusBadGateway, codeSSOProvider)
	}
	flow := oidc.NewFlow(s.cfg.Now())
	flow.InviteID = inviteID
	if target, err = provider.AuthorizationURL(oidcClient(settings), flow, fresh); err != nil {
		return "", "", err
	}
	sealed, err := flow.Seal(s.oidcFlowKey)
	if err != nil {
		return "", "", err
	}
	return target, s.flowCookie(ctx, sealed), nil
}

// StartOIDC sends a browser to the provider.
func (s *Server) StartOIDC(ctx context.Context, req oapi.StartOIDCRequestObject) (oapi.StartOIDCResponseObject, error) {
	target, cookie, err := s.beginFlow(ctx, "", req.Params.Fresh != nil && *req.Params.Fresh)
	if err != nil {
		return s.ssoFailure(ctx, err)
	}
	return redirectResponse{location: target, cookies: []string{cookie}}, nil
}

// StartOIDCWithInvite does the same for an invite, whose token stays out of the URL.
// The invite is burnt when the account is made, and a refused sign-in does not use it.
func (s *Server) StartOIDCWithInvite(ctx context.Context, req oapi.StartOIDCWithInviteRequestObject) (oapi.StartOIDCWithInviteResponseObject, error) {
	if err := s.checkAttempt(ctx); err != nil {
		return nil, err
	}
	invite, err := s.store.InviteByHash(ctx, auth.HashToken(req.Body.InviteToken))
	if errors.Is(err, store.ErrNotFound) || (err == nil && !inviteOpen(invite, s.cfg.Now())) {
		return nil, fail(http.StatusForbidden, codeInviteInvalid)
	}
	if err != nil {
		return nil, err
	}
	target, cookie, err := s.beginFlow(ctx, invite.ID, false)
	if err != nil {
		return nil, err
	}
	return oapi.StartOIDCWithInvite200JSONResponse{
		Body:    oapi.OIDCStart{AuthorizeUrl: target},
		Headers: oapi.StartOIDCWithInvite200ResponseHeaders{SetCookie: &cookie},
	}, nil
}

func inviteOpen(inv store.Invite, now time.Time) bool { return !inv.Used && now.Before(inv.ExpiresAt) }

// FinishOIDC is where the provider sends a browser back. Whatever happens, the flow
// cookie is over, and the browser goes back to the app.
func (s *Server) FinishOIDC(ctx context.Context, req oapi.FinishOIDCRequestObject) (oapi.FinishOIDCResponseObject, error) {
	clearFlow := s.flowCookie(ctx, "")
	flow, claims, settings, err := s.identify(ctx, req)
	if err != nil {
		return s.ssoFailure(ctx, err, clearFlow)
	}
	// Everything over the network is done: this part holds the lock.
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	account, err := s.resolveIdentity(ctx, settings, flow, claims)
	if err != nil {
		return s.ssoFailure(ctx, err, clearFlow)
	}
	token, err := s.openSession(ctx, account)
	if err != nil {
		return s.ssoFailure(ctx, err, clearFlow)
	}
	s.audit(ctx, auditSSOSucceeded, account.ID, account.ID)
	return redirectResponse{
		location: oidcSuccessPath,
		cookies:  []string{*s.sessionCookieHeader(ctx, token), clearFlow},
	}, nil
}

// identify establishes who came back: the flow is this browser's, the code was good,
// the token verifies. The state is checked before anything else in the request is
// looked at, so that nobody else's link can say anything to this browser.
func (s *Server) identify(ctx context.Context, req oapi.FinishOIDCRequestObject) (oidc.Flow, oidc.Claims, store.Settings, error) {
	var none oidc.Claims
	if err := s.checkAttempt(ctx); err != nil {
		return oidc.Flow{}, none, store.Settings{}, err
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return oidc.Flow{}, none, settings, err
	}
	if !settings.OIDC.Enabled {
		return oidc.Flow{}, none, settings, fail(http.StatusConflict, codeSSODisabled)
	}
	r := requestFrom(ctx)
	name := flowCookiePlain
	if s.requestSecure(r) {
		name = flowCookieSecure
	}
	cookie, err := r.Cookie(name)
	if err != nil {
		return oidc.Flow{}, none, settings, fail(http.StatusBadRequest, codeSSOState)
	}
	flow, err := oidc.OpenFlow(s.oidcFlowKey, cookie.Value, s.cfg.Now())
	if err != nil || req.Params.State == nil || subtle.ConstantTimeCompare([]byte(*req.Params.State), []byte(flow.State)) != 1 {
		return oidc.Flow{}, none, settings, fail(http.StatusBadRequest, codeSSOState)
	}
	if req.Params.Error != nil || req.Params.Code == nil {
		return oidc.Flow{}, none, settings, fail(http.StatusForbidden, codeSSODenied)
	}
	provider, err := s.provider(ctx, settings.OIDC)
	if err != nil {
		return oidc.Flow{}, none, settings, err
	}
	tokens, err := provider.Exchange(ctx, oidcClient(settings), *req.Params.Code, flow.Verifier)
	if err != nil {
		return oidc.Flow{}, none, settings, err
	}
	claims, err := provider.VerifyIDToken(ctx, tokens.IDToken, settings.OIDC.ClientID, flow.Nonce)
	if err != nil {
		return oidc.Flow{}, none, settings, err
	}
	if missesClaims(claims, settings.OIDC) && provider.HasUserInfo() && tokens.AccessToken != "" {
		info, err := provider.UserInfo(ctx, tokens.AccessToken, claims.Subject)
		if err != nil {
			return oidc.Flow{}, none, settings, err
		}
		claims = claims.Fill(info)
	}
	return flow, claims, settings, nil
}

// missesClaims says whether the ID token left out something the sign-in uses, which
// many providers keep for userinfo.
func missesClaims(c oidc.Claims, o store.OIDCSettings) bool {
	return c.Email == "" || !c.Has("email_verified") || c.PreferredUsername == "" ||
		(o.AdminGroup != "" && !c.Has(o.AdminClaim))
}

// resolveIdentity finds or makes the account of an identity, and applies the admin
// group. An account is only ever found by the identity it already has, or linked by
// the match mode if it has none: nothing here moves one to another identity. The
// caller holds accountMu.
func (s *Server) resolveIdentity(ctx context.Context, settings store.Settings, flow oidc.Flow, claims oidc.Claims) (store.User, error) {
	issuer := settings.OIDC.Issuer
	user, err := s.store.UserByIdentity(ctx, issuer, claims.Subject)
	switch {
	case err == nil:
	case !errors.Is(err, store.ErrNotFound):
		return store.User{}, err
	default:
		candidate, found, err := s.matchAccount(ctx, settings.OIDC.MatchMode, claims)
		if err != nil {
			return store.User{}, err
		}
		if found {
			user, err = s.linkAccount(ctx, candidate, issuer, claims.Subject)
		} else {
			user, err = s.createFromIdentity(ctx, settings, flow, claims)
		}
		if err != nil {
			return store.User{}, err
		}
	}
	if user.Disabled {
		return store.User{}, fail(http.StatusForbidden, codeUserDisabled)
	}
	return s.applyAdminGroup(ctx, settings.OIDC, user, claims)
}

// matchAccount finds the local account the match mode links an identity to.
func (s *Server) matchAccount(ctx context.Context, mode string, claims oidc.Claims) (store.User, bool, error) {
	var user store.User
	var err error
	switch mode {
	case store.MatchEmail:
		if claims.Email == "" {
			return store.User{}, false, nil
		}
		user, err = s.store.UserByEmail(ctx, strings.TrimSpace(claims.Email))
		if err == nil && !claims.EmailVerified {
			// PLAN section 3: an address the provider has not verified is anybody's.
			return store.User{}, false, fail(http.StatusForbidden, codeSSOUnverified)
		}
	case store.MatchUsername:
		name := normalizeUsername(claims.PreferredUsername)
		if !usernamePattern.MatchString(name) {
			return store.User{}, false, nil
		}
		user, err = s.store.UserByUsername(ctx, name)
	default:
		return store.User{}, false, nil
	}
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, false, nil
	}
	return user, err == nil, err
}

func (s *Server) linkAccount(ctx context.Context, user store.User, issuer, subject string) (store.User, error) {
	if user.HasIdentity() {
		return store.User{}, fail(http.StatusConflict, codeSSOConflict)
	}
	if user.Disabled {
		return store.User{}, fail(http.StatusForbidden, codeUserDisabled)
	}
	switch err := s.store.LinkIdentity(ctx, user.ID, issuer, subject); {
	case errors.Is(err, store.ErrIdentityTaken):
		return store.User{}, fail(http.StatusConflict, codeSSOConflict)
	case err != nil:
		return store.User{}, err
	}
	s.audit(ctx, auditSSOLinked, user.ID, user.ID)
	user.OIDCIssuer, user.OIDCSubject = issuer, subject
	return user, nil
}

// findInvite returns the invite that lets an identity in, if any: the one the sign-in
// started with, or an open one for its verified address.
func (s *Server) findInvite(ctx context.Context, flow oidc.Flow, claims oidc.Claims, now time.Time) (store.Invite, error) {
	verified := ""
	if claims.EmailVerified {
		verified = strings.TrimSpace(claims.Email)
	}
	if flow.InviteID != "" {
		invite, err := s.store.InviteByID(ctx, flow.InviteID)
		if errors.Is(err, store.ErrNotFound) || (err == nil && !inviteOpen(invite, now)) {
			return store.Invite{}, fail(http.StatusForbidden, codeInviteInvalid)
		}
		if err != nil {
			return store.Invite{}, err
		}
		if invite.Email != "" && !strings.EqualFold(invite.Email, verified) {
			return store.Invite{}, fail(http.StatusForbidden, codeInviteInvalid)
		}
		return invite, nil
	}
	if verified == "" {
		return store.Invite{}, nil
	}
	invite, err := s.store.OpenInviteForEmail(ctx, verified, now)
	if errors.Is(err, store.ErrNotFound) {
		return store.Invite{}, nil
	}
	return invite, err
}

// createFromIdentity makes an account for an identity that links to nothing. It holds
// no credentials. Only a verified address is stored, as the address of an account
// blocks anyone else from using it.
func (s *Server) createFromIdentity(ctx context.Context, settings store.Settings, flow oidc.Flow, claims oidc.Claims) (store.User, error) {
	now := s.cfg.Now()
	invite, err := s.findInvite(ctx, flow, claims, now)
	if err != nil {
		return store.User{}, err
	}
	if invite.ID == "" && settings.OIDC.NewUsers != store.NewUsersCreate {
		return store.User{}, fail(http.StatusForbidden, codeSSONotInvited)
	}
	user := store.User{
		Role:        string(oapi.User),
		QuotaBytes:  settings.DefaultQuotaBytes,
		CreatedAt:   now,
		OIDCIssuer:  settings.OIDC.Issuer,
		OIDCSubject: claims.Subject,
	}
	if invite.ID != "" {
		user.Role = invite.Role
		if invite.QuotaBytes != nil {
			user.QuotaBytes = *invite.QuotaBytes
		}
	}
	if email := strings.TrimSpace(claims.Email); claims.EmailVerified && validEmail(email) {
		user.Email = email
	}
	base := usernameBase(claims)
	for try := 0; ; try++ {
		user.ID = store.NewID()
		user.Username = usernameCandidate(base, try)
		err := s.store.CreateUser(ctx, user, invite.ID, now)
		switch {
		case err == nil:
			s.audit(ctx, auditSSOCreated, user.ID, user.ID)
			return user, nil
		case errors.Is(err, store.ErrUsernameTaken):
			continue
		case errors.Is(err, store.ErrEmailTaken):
			// Someone else has it, and has not been matched: the account goes without.
			user.Email = ""
			try--
		case errors.Is(err, store.ErrInviteInvalid):
			return store.User{}, fail(http.StatusForbidden, codeInviteInvalid)
		case errors.Is(err, store.ErrIdentityTaken):
			return store.User{}, fail(http.StatusConflict, codeSSOConflict)
		default:
			return store.User{}, err
		}
	}
}

// usernameBase makes a valid username out of what a provider says. A name that is
// taken is not a match, so it never gets its holder's account: it gets a suffix.
func usernameBase(claims oidc.Claims) string {
	name := claims.PreferredUsername
	if name == "" {
		name, _, _ = strings.Cut(claims.Email, "@")
	}
	name = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		}
		return '-'
	}, normalizeUsername(name))
	name = strings.TrimLeft(name, "._-")
	if len(name) > maxUsernameBaseLen {
		name = name[:maxUsernameBaseLen]
	}
	if name == "" {
		return "user"
	}
	return name
}

func usernameCandidate(base string, try int) string {
	switch {
	case try == 0:
		return base
	case try < maxUsernameTries:
		return base + "-" + strconv.Itoa(try+1)
	}
	return base + "-" + store.NewID()[:5]
}

// applyAdminGroup makes the role follow the group, when a group is set. Being left
// out of it, or the claim being absent, is not being in it. The fallback admin is
// the way back in if the group goes wrong, so it keeps its role, as does the last
// admin of any kind.
func (s *Server) applyAdminGroup(ctx context.Context, o store.OIDCSettings, user store.User, claims oidc.Claims) (store.User, error) {
	if o.AdminGroup == "" {
		return user, nil
	}
	member := slices.Contains(claims.StringList(o.AdminClaim), o.AdminGroup)
	isAdmin := user.Role == string(oapi.Admin)
	if member == isAdmin {
		return user, nil
	}
	if member {
		if err := s.store.SetRole(ctx, user.ID, string(oapi.Admin)); err != nil {
			return store.User{}, err
		}
		s.audit(ctx, auditSSOPromoted, user.ID, user.ID)
		user.Role = string(oapi.Admin)
		return user, nil
	}
	locals, err := s.store.LocalAdmins(ctx)
	if err != nil {
		return store.User{}, err
	}
	admins, err := s.store.CountAdmins(ctx)
	if err != nil {
		return store.User{}, err
	}
	if (len(locals) > 0 && locals[0] == user.ID) || admins <= 1 {
		return user, nil
	}
	if err := s.store.SetRole(ctx, user.ID, string(oapi.User)); err != nil {
		return store.User{}, err
	}
	s.audit(ctx, auditSSODemoted, user.ID, user.ID)
	user.Role = string(oapi.User)
	return user, nil
}

// EnrolOIDC stores the keys of a single sign-on account, once, on the strength of the
// session alone: there is nothing yet for a stolen session to take. The condition in
// the store is what makes it once.
func (s *Server) EnrolOIDC(ctx context.Context, req oapi.EnrolOIDCRequestObject) (oapi.EnrolOIDCResponseObject, error) {
	p, err := sessionPrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if *s.mode.Load() != oapi.ModeE2e {
		return nil, fail(http.StatusConflict, codeWrongMode)
	}
	in := req.Body
	if len(in.UnlockAuthKey) != auth.AuthKeyLen || len(in.RecoveryAuthKey) != auth.AuthKeyLen {
		return nil, badRequest(codeInvalidAuthKey)
	}
	kdf, err := encodeKDF(in.Kdf)
	if err != nil {
		return nil, err
	}
	if !validAccountKeys(in.Keys) {
		return nil, badRequest(codeInvalidKeys)
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	if !p.user.SSOOnly() {
		return nil, fail(http.StatusConflict, codeAlreadyEnrolled)
	}
	err = s.store.Enrol(ctx, p.user.ID, store.Credentials{
		UnlockAuthKeyHash:        auth.HashKey(in.UnlockAuthKey),
		KDF:                      kdf,
		RecoveryAuthKeyHash:      auth.HashKey(in.RecoveryAuthKey),
		WrappedMasterKey:         in.Keys.WrappedMasterKey,
		WrappedMasterKeyRecovery: in.Keys.WrappedMasterKeyRecovery,
		SealedX25519:             in.Keys.SealedX25519,
		SealedEd25519:            in.Keys.SealedEd25519,
		PublicKeyX25519:          in.Keys.PublicKeys.X25519,
		PublicKeyEd25519:         in.Keys.PublicKeys.Ed25519,
	})
	if errors.Is(err, store.ErrAlreadyEnrolled) {
		return nil, fail(http.StatusConflict, codeAlreadyEnrolled)
	}
	if err != nil {
		return nil, err
	}
	s.audit(ctx, auditSSOEnrolled, p.user.ID, p.user.ID)
	user, err := s.store.UserByID(ctx, p.user.ID)
	if err != nil {
		return nil, err
	}
	account, err := s.account(user)
	if err != nil {
		return nil, err
	}
	return oapi.EnrolOIDC200JSONResponse(account), nil
}

// TestOIDC fetches a provider's configuration and keys, afresh, and reports what it
// found. The issuer is whatever was typed, so the answer is a code or the endpoints,
// and never what a failing address sent back.
func (s *Server) TestOIDC(ctx context.Context, req oapi.TestOIDCRequestObject) (oapi.TestOIDCResponseObject, error) {
	if !s.kdfLimiter.Allow(s.rateLimitKey(requestFrom(ctx))) {
		return nil, fail(http.StatusTooManyRequests, codeRateLimited)
	}
	issuer := strings.TrimSpace(req.Body.Issuer)
	insecure := req.Body.AllowInsecure != nil && *req.Body.AllowInsecure
	provider, err := oidc.Discover(ctx, s.oidcHTTP, issuer, insecure, s.cfg.Now)
	switch {
	case errors.Is(err, oidc.ErrInvalidIssuer):
		return nil, badRequest(codeInvalidIssuer)
	case errors.Is(err, oidc.ErrIssuerMismatch):
		return nil, fail(http.StatusBadGateway, codeOIDCIssuerMismatch)
	case err != nil:
		s.log.Warn("identity provider test failed", "error", err)
		return nil, fail(http.StatusBadGateway, codeOIDCDiscovery)
	}
	keys, err := provider.FetchKeys(ctx)
	if err != nil || keys == 0 {
		s.log.Warn("identity provider test found no keys", "error", err)
		return nil, fail(http.StatusBadGateway, codeOIDCKeys)
	}
	meta := provider.Metadata()
	out := oapi.TestOIDC200JSONResponse{
		Issuer:                meta.Issuer,
		AuthorizationEndpoint: meta.AuthorizationEndpoint,
		TokenEndpoint:         meta.TokenEndpoint,
		JwksUri:               meta.JWKSURI,
		TokenAuthMethod:       provider.TokenAuthMethod(),
		PkceS256:              slices.Contains(meta.CodeChallengeMethods, "S256"),
		Keys:                  keys,
	}
	if meta.UserinfoEndpoint != "" {
		out.UserinfoEndpoint = &meta.UserinfoEndpoint
	}
	return out, nil
}

// UnlinkIdentity forgets the identity of an account, which is the one way an account
// comes to another identity: sign-in never does this on its own.
func (s *Server) UnlinkIdentity(ctx context.Context, req oapi.UnlinkIdentityRequestObject) (oapi.UnlinkIdentityResponseObject, error) {
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	if _, err := s.verifyCurrentKey(ctx, req.Body.CurrentAuthKey); err != nil {
		return nil, err
	}
	actor, err := s.checkModifiable(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	revoked, err := s.store.UnlinkIdentity(ctx, req.Id)
	if err != nil {
		return nil, notFound(err)
	}
	s.keys.Drop(revoked...)
	s.audit(ctx, auditSSOUnlinked, actor, req.Id)
	return oapi.UnlinkIdentity204Response{}, nil
}
