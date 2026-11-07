package server

import (
	"context"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Audit actions for device tokens.
const (
	auditTokenCreated = "token_created" //nolint:gosec // an event name, not a secret
	auditTokenRevoked = "token_revoked" //nolint:gosec // an event name, not a secret
)

// CreateToken issues a named bearer token for a device. Only its hash is kept.
func (s *Server) CreateToken(ctx context.Context, req oapi.CreateTokenRequestObject) (oapi.CreateTokenResponseObject, error) {
	if !validServerName(req.Body.Name) {
		return nil, badRequest(codeInvalidTokenName)
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.verifyCurrentKey(ctx, req.Body.CurrentAuthKey)
	if err != nil {
		return nil, err
	}
	secret := auth.NewToken()
	token := store.Token{
		ID:        store.NewID(),
		UserID:    user.ID,
		Name:      req.Body.Name,
		Hash:      auth.HashToken(secret),
		CreatedAt: s.cfg.Now(),
	}
	if err := s.store.CreateToken(ctx, token); err != nil {
		return nil, err
	}
	s.audit(ctx, auditTokenCreated, user.ID, token.ID)
	return oapi.CreateToken201JSONResponse{Token: tokenView(token), Secret: secret}, nil
}

// ListTokens returns the signed-in user's tokens.
func (s *Server) ListTokens(ctx context.Context, _ oapi.ListTokensRequestObject) (oapi.ListTokensResponseObject, error) {
	tokens, err := s.store.ListTokens(ctx, principalFrom(ctx).user.ID)
	if err != nil {
		return nil, err
	}
	out := make(oapi.ListTokens200JSONResponse, 0, len(tokens))
	for _, t := range tokens {
		out = append(out, tokenView(t))
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

func tokenView(t store.Token) oapi.DeviceToken {
	v := oapi.DeviceToken{Id: t.ID, Name: t.Name, CreatedAt: t.CreatedAt}
	if !t.LastUsedAt.IsZero() {
		v.LastUsedAt = &t.LastUsedAt
	}
	return v
}
