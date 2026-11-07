package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Audit actions for invites.
const (
	auditInviteCreated = "invite_created"
	auditInviteRevoked = "invite_revoked"
)

// Invite lifetimes.
const (
	defaultInviteTTL = 7 * 24 * time.Hour
	minInviteTTL     = time.Minute
	maxInviteTTL     = 90 * 24 * time.Hour
)

// CreateInvite issues a one-time invite. Only the hash of its token is kept.
func (s *Server) CreateInvite(ctx context.Context, req oapi.CreateInviteRequestObject) (oapi.CreateInviteResponseObject, error) {
	ttl := defaultInviteTTL
	if req.Body.ExpiresInSeconds != nil {
		ttl = time.Duration(*req.Body.ExpiresInSeconds) * time.Second
		if ttl < minInviteTTL || ttl > maxInviteTTL {
			return nil, badRequest(codeInvalidInvite)
		}
	}
	role := oapi.User
	if req.Body.Role != nil {
		if !req.Body.Role.Valid() {
			return nil, badRequest(codeInvalidInvite)
		}
		role = *req.Body.Role
	}
	if req.Body.QuotaBytes != nil && *req.Body.QuotaBytes < 0 {
		return nil, badRequest(codeInvalidInvite)
	}
	var email string
	if req.Body.Email != nil {
		email = strings.TrimSpace(*req.Body.Email)
		if !validEmail(email) {
			return nil, badRequest(codeInvalidEmail)
		}
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}

	token := auth.NewToken()
	now := s.cfg.Now()
	actor := principalFrom(ctx).user.ID
	invite := store.Invite{
		ID:         store.NewID(),
		TokenHash:  auth.HashToken(token),
		Email:      email,
		Role:       string(role),
		QuotaBytes: req.Body.QuotaBytes,
		CreatedBy:  actor,
		CreatedAt:  now,
		ExpiresAt:  now.Add(ttl),
	}
	if err := s.store.CreateInvite(ctx, invite); err != nil {
		return nil, err
	}
	s.audit(ctx, auditInviteCreated, actor, invite.ID)
	return oapi.CreateInvite201JSONResponse{
		Invite: inviteView(invite),
		Token:  token,
		Link:   settings.PublicURL + "/invite#" + token,
	}, nil
}

// ListInvites returns every invite, used ones included.
func (s *Server) ListInvites(ctx context.Context, _ oapi.ListInvitesRequestObject) (oapi.ListInvitesResponseObject, error) {
	invites, err := s.store.ListInvites(ctx)
	if err != nil {
		return nil, err
	}
	out := make(oapi.ListInvites200JSONResponse, 0, len(invites))
	for _, inv := range invites {
		out = append(out, inviteView(inv))
	}
	return out, nil
}

// DeleteInvite revokes an invite.
func (s *Server) DeleteInvite(ctx context.Context, req oapi.DeleteInviteRequestObject) (oapi.DeleteInviteResponseObject, error) {
	err := s.store.DeleteInvite(ctx, req.Id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, fail(http.StatusNotFound, codeNotFound)
	}
	if err != nil {
		return nil, err
	}
	s.audit(ctx, auditInviteRevoked, principalFrom(ctx).user.ID, req.Id)
	return oapi.DeleteInvite204Response{}, nil
}

func inviteView(inv store.Invite) oapi.Invite {
	v := oapi.Invite{
		Id:         inv.ID,
		Role:       oapi.Role(inv.Role),
		QuotaBytes: inv.QuotaBytes,
		CreatedAt:  inv.CreatedAt,
		ExpiresAt:  inv.ExpiresAt,
		Used:       inv.Used,
	}
	if inv.Email != "" {
		v.Email = &inv.Email
	}
	return v
}
