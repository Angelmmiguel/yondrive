package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Audit actions for accounts. They name the event and nothing else: no
// username typed at a sign-in form goes in, since people type passwords there.
const (
	auditLoginSucceeded     = "login_succeeded"
	auditLoginFailed        = "login_failed"
	auditLogout             = "logout"
	auditRegistered         = "user_registered"
	auditRekeyed            = "credentials_rekeyed"
	auditCredentialRejected = "credential_rejected" //nolint:gosec // an event name, not a secret
)

// GetKDF returns the stored parameters of a username, or stable fake ones of
// the same shape if there is no such account.
func (s *Server) GetKDF(ctx context.Context, req oapi.GetKDFRequestObject) (oapi.GetKDFResponseObject, error) {
	if !s.kdfLimiter.Allow(s.rateLimitKey(requestFrom(ctx))) {
		return nil, fail(http.StatusTooManyRequests, codeRateLimited)
	}
	username := normalizeUsername(req.Params.Username)
	user, err := s.store.UserByUsername(ctx, username)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	// A single sign-on account does not sign in here, and gets its real parameters
	// from GET /me: to anyone asking here it looks like nobody at all.
	if user.KDF == nil || user.SSOOnly() {
		return oapi.GetKDF200JSONResponse(s.fakeKDF(username)), nil
	}
	kdf, err := decodeKDF(user.KDF)
	if err != nil {
		return nil, err
	}
	return oapi.GetKDF200JSONResponse(kdf), nil
}

// fakeKDF is parameters of the right shape, for a name with none to show.
func (s *Server) fakeKDF(username string) oapi.KDF {
	return oapi.KDF{
		Name: oapi.Argon2id,
		M:    auth.KDFMemoryKiB,
		T:    auth.KDFIterations,
		P:    auth.KDFParallelism,
		Salt: auth.FakeSalt(s.secret, username),
	}
}

func decodeKDF(stored []byte) (oapi.KDF, error) {
	var kdf oapi.KDF
	if err := json.Unmarshal(stored, &kdf); err != nil {
		return oapi.KDF{}, fmt.Errorf("server: stored kdf: %w", err)
	}
	return kdf, nil
}

// Login exchanges an auth key for a session. Checking the credential and
// creating the session happen under the account lock, so a rekey cannot slip
// between them and leave a session opened on a retired credential.
func (s *Server) Login(ctx context.Context, req oapi.LoginRequestObject) (oapi.LoginResponseObject, error) {
	username, err := s.checkSignInAttempt(ctx, req.Body.Username)
	if err != nil {
		return nil, err
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.authenticateLocal(ctx, username, req.Body.AuthKey, req.Body.TotpCode, req.Body.TotpRecoveryCode)
	if err != nil {
		return nil, err
	}

	token, err := s.openSession(ctx, user)
	if err != nil {
		return nil, err
	}
	s.audit(ctx, auditLoginSucceeded, user.ID, user.ID)
	account, err := s.account(user)
	if err != nil {
		return nil, err
	}
	return oapi.Login200JSONResponse{
		Body:    account,
		Headers: oapi.Login200ResponseHeaders{SetCookie: s.sessionCookieHeader(ctx, token)},
	}, nil
}

// LoginDevice signs a native client in: the credentials of Login, answered with a
// bearer token in place of a session. The auth key is the current credential that
// making a token needs, so the token is minted under the same lock as the check.
func (s *Server) LoginDevice(ctx context.Context, req oapi.LoginDeviceRequestObject) (oapi.LoginDeviceResponseObject, error) {
	username, err := s.checkSignInAttempt(ctx, req.Body.Username)
	if err != nil {
		return nil, err
	}
	if !validName(req.Body.Device.Name) {
		return nil, badRequest(codeInvalidTokenName)
	}
	platform, err := platformOf(req.Body.Device.Platform)
	if err != nil {
		return nil, err
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.authenticateLocal(ctx, username, req.Body.AuthKey, req.Body.TotpCode, req.Body.TotpRecoveryCode)
	if err != nil {
		return nil, err
	}
	token, secret, err := s.mintToken(ctx, user.ID, req.Body.Device.Name, platform, store.TokenOriginLogin)
	if err != nil {
		return nil, err
	}
	s.audit(ctx, auditLoginSucceeded, user.ID, user.ID)
	account, err := s.account(user)
	if err != nil {
		return nil, err
	}
	return oapi.LoginDevice201JSONResponse{Account: account, Token: tokenView(token, token.ID), Secret: secret}, nil
}

// checkSignInAttempt counts a sign-in against the caller's address and the
// username, and returns the username as stored.
func (s *Server) checkSignInAttempt(ctx context.Context, raw string) (string, error) {
	if err := s.checkAttempt(ctx); err != nil {
		return "", err
	}
	username := normalizeUsername(raw)
	if usernamePattern.MatchString(username) && !s.usernameLimiter.Allow(username) {
		return "", fail(http.StatusTooManyRequests, codeRateLimited)
	}
	return username, nil
}

// authenticateLocal checks a local sign-in up to and including the second
// factor, and returns the user. The caller holds accountMu.
func (s *Server) authenticateLocal(ctx context.Context, username string, authKey []byte, code, recoveryCode *string) (store.User, error) {
	user, err := s.store.UserByUsername(ctx, username)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return store.User{}, err
	}
	// An account with no passphrase has nothing to sign in with here. Its recovery
	// key is not offered, so that this answers as it does for a name that does not
	// exist, and does not confirm the key.
	recovery := user.RecoveryAuthKeyHash
	if user.SSOOnly() {
		recovery = nil
	}
	if !auth.VerifyKey(authKey, user.AuthKeyHash, recovery) {
		s.audit(ctx, auditLoginFailed, "", user.ID)
		s.log.Warn("login failed", "remote", s.clientIP(requestFrom(ctx)))
		return store.User{}, fail(http.StatusUnauthorized, codeInvalidCredentials)
	}
	if user.Disabled {
		s.audit(ctx, auditLoginFailed, "", user.ID)
		return store.User{}, fail(http.StatusForbidden, codeUserDisabled)
	}
	if err := s.checkLocalSignIn(ctx, user); err != nil {
		s.audit(ctx, auditLoginFailed, "", user.ID)
		return store.User{}, err
	}
	if user.TOTPEnabled {
		if code == nil && recoveryCode == nil {
			return store.User{}, fail(http.StatusUnauthorized, codeTOTPRequired)
		}
		if err := s.checkSecondFactor(ctx, user, code, recoveryCode); err != nil {
			return store.User{}, err
		}
	}
	return user, nil
}

// openSession makes a session and returns its token. The caller holds accountMu.
func (s *Server) openSession(ctx context.Context, user store.User) (string, error) {
	token := auth.NewToken()
	now := s.cfg.Now()
	err := s.store.CreateSession(ctx, store.Session{
		Hash:       auth.HashToken(token),
		UserID:     user.ID,
		CreatedAt:  now,
		ExpiresAt:  now.Add(s.cfg.SessionTTL),
		AbsoluteAt: now.Add(s.cfg.SessionMaxAge),
	})
	return token, err
}

// Logout ends the session and forgets its key.
func (s *Server) Logout(ctx context.Context, _ oapi.LogoutRequestObject) (oapi.LogoutResponseObject, error) {
	p := principalFrom(ctx)
	if p.tokenID != "" {
		if err := s.store.DeleteToken(ctx, p.user.ID, p.tokenID); err != nil {
			return nil, err
		}
		s.audit(ctx, auditTokenRevoked, p.user.ID, p.tokenID)
		return oapi.Logout204Response{}, nil
	}
	if err := s.store.DeleteSession(ctx, p.sessionHash); err != nil {
		return nil, err
	}
	s.keys.Drop(p.sessionHash)
	s.audit(ctx, auditLogout, p.user.ID, p.user.ID)
	return oapi.Logout204Response{
		Headers: oapi.Logout204ResponseHeaders{SetCookie: s.sessionCookieHeader(ctx, "")},
	}, nil
}

// Register creates an account from an invite, or freely if the server allows
// open sign-up. The invite is checked first, so that nothing about usernames
// is learnt without one, and burnt in the transaction that creates the user.
func (s *Server) Register(ctx context.Context, req oapi.RegisterRequestObject) (oapi.RegisterResponseObject, error) {
	if err := s.checkAttempt(ctx); err != nil {
		return nil, err
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	if !settings.LocalAccounts {
		return nil, fail(http.StatusForbidden, codeLocalDisabled)
	}
	now := s.cfg.Now()
	var invite store.Invite
	if req.Body.InviteToken != nil {
		invite, err = s.store.InviteByHash(ctx, auth.HashToken(*req.Body.InviteToken))
		if errors.Is(err, store.ErrNotFound) || (err == nil && (invite.Used || !now.Before(invite.ExpiresAt))) {
			return nil, fail(http.StatusForbidden, codeInviteInvalid)
		}
		if err != nil {
			return nil, err
		}
	} else if !settings.OpenSignup {
		return nil, fail(http.StatusForbidden, codeSignupClosed)
	}

	user, err := newUser(req.Body.Account, oapi.Mode(settings.Mode), now)
	if err != nil {
		return nil, err
	}
	user.Role = string(oapi.User)
	user.QuotaBytes = settings.DefaultQuotaBytes
	if invite.ID != "" {
		user.Role = invite.Role
		if invite.QuotaBytes != nil {
			user.QuotaBytes = *invite.QuotaBytes
		}
		if invite.Email != "" {
			user.Email = invite.Email
		}
	}
	switch err := s.store.CreateUser(ctx, user, invite.ID, now); {
	case errors.Is(err, store.ErrUsernameTaken):
		return nil, fail(http.StatusConflict, codeUsernameTaken)
	case errors.Is(err, store.ErrEmailTaken):
		return nil, fail(http.StatusConflict, codeEmailTaken)
	case errors.Is(err, store.ErrInviteInvalid):
		return nil, fail(http.StatusForbidden, codeInviteInvalid)
	case err != nil:
		return nil, err
	}
	s.audit(ctx, auditRegistered, user.ID, user.ID)
	return oapi.Register201JSONResponse{UserId: user.ID}, nil
}

// Rekey replaces credentials and wrapped keys in one transaction, and ends all
// other access. The session is not proof enough: a hijacked cookie could
// otherwise lock the owner out for good, so the caller must also present a
// current auth key. That makes this a second place to guess one, and it shares
// the sign-in limit. A rejected key answers wrong_credential, distinct from the
// unauthorized of a dead session.
func (s *Server) Rekey(ctx context.Context, req oapi.RekeyRequestObject) (oapi.RekeyResponseObject, error) {
	up, err := rekeyUpdate(req.Body, *s.mode.Load())
	if err != nil {
		return nil, err
	}
	p := principalFrom(ctx)

	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.verifyCurrentKey(ctx, req.Body.CurrentAuthKey)
	if err != nil {
		return nil, err
	}
	if user.SSOOnly() {
		if *s.mode.Load() == oapi.ModeNone {
			return nil, fail(http.StatusConflict, codeSSOOnly)
		}
		// The new key goes where it proves a credential and cannot sign in.
		up.UnlockAuthKeyHash, up.AuthKeyHash = up.AuthKeyHash, nil
	}
	revoked, err := s.store.UpdateCredentials(ctx, user.ID, up, p.sessionHash, p.tokenID)
	if err != nil {
		return nil, err
	}
	s.keys.Drop(revoked...)
	s.audit(ctx, auditRekeyed, user.ID, user.ID)
	return oapi.Rekey204Response{}, nil
}

// rekeyUpdate checks that a rekey carries complete groups for the mode, and
// builds the update. A group half present would leave a credential that signs
// in next to a key that does not open, which is the failure rekey exists to
// prevent.
func rekeyUpdate(body *oapi.RekeyJSONRequestBody, mode oapi.Mode) (store.CredentialUpdate, error) {
	var up store.CredentialUpdate
	passphrase := body.AuthKey != nil || body.Kdf != nil || body.WrappedMasterKey != nil
	recovery := body.RecoveryAuthKey != nil || body.WrappedMasterKeyRecovery != nil
	if !passphrase && !recovery {
		return up, badRequest(codeInvalidRekey)
	}
	if mode == oapi.ModeNone && (recovery || body.WrappedMasterKey != nil) {
		return up, badRequest(codeKeysNotAllowed)
	}
	if passphrase {
		if body.AuthKey == nil || body.Kdf == nil || (mode == oapi.ModeE2e && body.WrappedMasterKey == nil) {
			return up, badRequest(codeInvalidRekey)
		}
		if len(*body.AuthKey) != auth.AuthKeyLen {
			return up, badRequest(codeInvalidAuthKey)
		}
		kdf, err := encodeKDF(*body.Kdf)
		if err != nil {
			return up, err
		}
		up.AuthKeyHash, up.KDF = auth.HashKey(*body.AuthKey), kdf
		if mode == oapi.ModeE2e {
			if !validSealed(*body.WrappedMasterKey) {
				return up, badRequest(codeInvalidKeys)
			}
			up.WrappedMasterKey = *body.WrappedMasterKey
		}
	}
	if recovery {
		if body.RecoveryAuthKey == nil || body.WrappedMasterKeyRecovery == nil {
			return up, badRequest(codeInvalidRekey)
		}
		if len(*body.RecoveryAuthKey) != auth.AuthKeyLen {
			return up, badRequest(codeInvalidAuthKey)
		}
		if !validSealed(*body.WrappedMasterKeyRecovery) {
			return up, badRequest(codeInvalidKeys)
		}
		up.RecoveryAuthKeyHash = auth.HashKey(*body.RecoveryAuthKey)
		up.WrappedMasterKeyRecovery = *body.WrappedMasterKeyRecovery
	}
	return up, nil
}

// GetMe returns the signed-in account.
func (s *Server) GetMe(ctx context.Context, _ oapi.GetMeRequestObject) (oapi.GetMeResponseObject, error) {
	account, err := s.account(principalFrom(ctx).user)
	if err != nil {
		return nil, err
	}
	return oapi.GetMe200JSONResponse(account), nil
}

// account is what a client needs to unlock: the blobs exactly as stored.
func (s *Server) account(u store.User) (oapi.Account, error) {
	kdf := s.fakeKDF(u.Username)
	if u.KDF != nil {
		var err error
		if kdf, err = decodeKDF(u.KDF); err != nil {
			return oapi.Account{}, err
		}
	}
	out := oapi.Account{User: profile(u), Mode: *s.mode.Load(), Kdf: kdf}
	if out.Mode == oapi.ModeE2e && u.WrappedMasterKey == nil {
		required := true
		out.EnrolmentRequired = &required
	}
	if u.WrappedMasterKey != nil {
		out.Keys = &oapi.AccountKeys{
			WrappedMasterKey:         u.WrappedMasterKey,
			WrappedMasterKeyRecovery: u.WrappedMasterKeyRecovery,
			SealedX25519:             u.SealedX25519,
			SealedEd25519:            u.SealedEd25519,
			PublicKeys:               oapi.PublicKeys{X25519: u.PublicKeyX25519, Ed25519: u.PublicKeyEd25519},
		}
	}
	return out, nil
}

func profile(u store.User) oapi.Profile {
	p := oapi.Profile{
		Id:          u.ID,
		Username:    u.Username,
		Role:        oapi.Role(u.Role),
		QuotaBytes:  u.QuotaBytes,
		TotpEnabled: u.TOTPEnabled,
		Disabled:    u.Disabled,
		CreatedAt:   u.CreatedAt,
	}
	if u.Email != "" {
		p.Email = &u.Email
	}
	method := oapi.Local
	switch {
	case u.SSOOnly():
		method = oapi.Sso
	case u.HasIdentity():
		method = oapi.Both
	}
	p.SignInMethod = &method
	return p
}

// GetUserKeys returns a user's public keys, which clients pin and compare.
func (s *Server) GetUserKeys(ctx context.Context, req oapi.GetUserKeysRequestObject) (oapi.GetUserKeysResponseObject, error) {
	u, err := s.store.UserByID(ctx, req.Id)
	if err != nil {
		return nil, notFound(err)
	}
	if u.PublicKeyX25519 == nil {
		return nil, fail(http.StatusNotFound, codeNoKeys)
	}
	return oapi.GetUserKeys200JSONResponse{
		UserId:     u.ID,
		Username:   u.Username,
		PublicKeys: oapi.PublicKeys{X25519: u.PublicKeyX25519, Ed25519: u.PublicKeyEd25519},
	}, nil
}

// PutSessionKey stores the server half of the session key, in memory only.
func (s *Server) PutSessionKey(ctx context.Context, req oapi.PutSessionKeyRequestObject) (oapi.PutSessionKeyResponseObject, error) {
	p, err := sessionPrincipal(ctx)
	if err != nil {
		return nil, err
	}
	if len(req.Body.Key) != auth.SessionKeyLen {
		return nil, badRequest(codeInvalidSessionKey)
	}
	s.keys.Set(p.sessionHash, req.Body.Key)
	return oapi.PutSessionKey204Response{}, nil
}

// GetSessionKey returns the server half of the session key, if it is set.
func (s *Server) GetSessionKey(ctx context.Context, _ oapi.GetSessionKeyRequestObject) (oapi.GetSessionKeyResponseObject, error) {
	p, err := sessionPrincipal(ctx)
	if err != nil {
		return nil, err
	}
	key, ok := s.keys.Get(p.sessionHash)
	if !ok {
		return nil, fail(http.StatusNotFound, codeNoSessionKey)
	}
	return oapi.GetSessionKey200JSONResponse{Key: key}, nil
}

// DeleteSessionKey forgets the server half of the session key: the client has
// locked.
func (s *Server) DeleteSessionKey(ctx context.Context, _ oapi.DeleteSessionKeyRequestObject) (oapi.DeleteSessionKeyResponseObject, error) {
	p, err := sessionPrincipal(ctx)
	if err != nil {
		return nil, err
	}
	s.keys.Drop(p.sessionHash)
	return oapi.DeleteSessionKey204Response{}, nil
}

// sessionPrincipal refuses a request that came through a bearer token: a native
// client keeps its keys itself and there is no session to hold a key on.
func sessionPrincipal(ctx context.Context) (principal, error) {
	p := principalFrom(ctx)
	if p.sessionHash == nil {
		return p, fail(http.StatusForbidden, codeSessionRequired)
	}
	return p, nil
}
