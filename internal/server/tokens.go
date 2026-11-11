package server

import (
	"context"
	"net/http"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Audit actions for device tokens.
const (
	auditTokenCreated = "token_created" //nolint:gosec // an event name, not a secret
	auditTokenRevoked = "token_revoked" //nolint:gosec // an event name, not a secret
)

// maxDevicesPerUser bounds the tokens of one user, so that a client looping on
// sign-in fills nothing up.
const maxDevicesPerUser = 24

// CreateToken issues a named bearer token for a device. Only its hash is kept.
func (s *Server) CreateToken(ctx context.Context, req oapi.CreateTokenRequestObject) (oapi.CreateTokenResponseObject, error) {
	if !validName(req.Body.Name) {
		return nil, badRequest(codeInvalidTokenName)
	}
	platform, err := platformOf(req.Body.Platform)
	if err != nil {
		return nil, err
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.verifyCurrentKey(ctx, req.Body.CurrentAuthKey)
	if err != nil {
		return nil, err
	}
	token, secret, err := s.mintToken(ctx, user.ID, req.Body.Name, platform, store.TokenOriginSettings)
	if err != nil {
		return nil, err
	}
	return oapi.CreateToken201JSONResponse{Token: tokenView(token, ""), Secret: secret}, nil
}

// mintToken makes a token, if the user has room for another, and returns its
// secret, which is not kept.
func (s *Server) mintToken(ctx context.Context, userID, name, platform, origin string) (store.Token, string, error) {
	if err := s.checkDeviceLimit(ctx, userID); err != nil {
		return store.Token{}, "", err
	}
	secret := auth.NewToken()
	token := store.Token{
		ID:        store.NewID(),
		UserID:    userID,
		Name:      name,
		Platform:  platform,
		Origin:    origin,
		Hash:      auth.HashToken(secret),
		CreatedAt: s.cfg.Now(),
	}
	if err := s.store.CreateToken(ctx, token); err != nil {
		return store.Token{}, "", err
	}
	s.audit(ctx, auditTokenCreated, userID, token.ID)
	return token, secret, nil
}

// checkDeviceLimit answers device_limit_reached if the user has all the tokens
// they may have.
func (s *Server) checkDeviceLimit(ctx context.Context, userID string) error {
	n, err := s.store.CountTokens(ctx, userID)
	if err != nil {
		return err
	}
	if n >= maxDevicesPerUser {
		return fail(http.StatusConflict, codeDeviceLimitReached)
	}
	return nil
}

// ListTokens returns the signed-in user's tokens.
func (s *Server) ListTokens(ctx context.Context, _ oapi.ListTokensRequestObject) (oapi.ListTokensResponseObject, error) {
	p := principalFrom(ctx)
	tokens, err := s.store.ListTokens(ctx, p.user.ID)
	if err != nil {
		return nil, err
	}
	out := make(oapi.ListTokens200JSONResponse, 0, len(tokens))
	for _, t := range tokens {
		out = append(out, tokenView(t, p.tokenID))
	}
	return out, nil
}

// RevokeToken ends one of the signed-in user's tokens.
func (s *Server) RevokeToken(ctx context.Context, req oapi.RevokeTokenRequestObject) (oapi.RevokeTokenResponseObject, error) {
	actor := principalFrom(ctx).user.ID
	if err := s.store.DeleteToken(ctx, actor, req.Id); err != nil {
		return nil, notFound(err)
	}
	s.audit(ctx, auditTokenRevoked, actor, req.Id)
	return oapi.RevokeToken204Response{}, nil
}

// tokenView shows a token, marked as the caller's own when its id is current.
func tokenView(t store.Token, current string) oapi.DeviceToken {
	v := oapi.DeviceToken{Id: t.ID, Name: t.Name, Origin: oapi.DeviceTokenOrigin(t.Origin), CreatedAt: t.CreatedAt}
	if t.Platform != "" {
		platform := oapi.DevicePlatform(t.Platform)
		v.Platform = &platform
	}
	if !t.LastUsedAt.IsZero() {
		v.LastUsedAt = &t.LastUsedAt
	}
	if current != "" && t.ID == current {
		yes := true
		v.Current = &yes
	}
	return v
}
