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

// passwordResetTTL is how long a reset link works.
const passwordResetTTL = 24 * time.Hour

// The bounds of the settings counted in days.
const (
	minPurgeGraceDays = 1
	maxSettingDays    = 3650
)

// Audit actions for administration.
const (
	auditUserDisabled    = "user_disabled"
	auditUserEnabled     = "user_enabled"
	auditUserDeleted     = "user_deleted"
	auditQuotaSet        = "quota_set"
	auditSettingsChanged = "settings_changed"
	auditResetIssued     = "password_reset_issued"
	auditResetCompleted  = "password_reset_completed"
)

// ListUsers returns every user, without their blobs.
func (s *Server) ListUsers(ctx context.Context, _ oapi.ListUsersRequestObject) (oapi.ListUsersResponseObject, error) {
	users, err := s.store.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	out := make(oapi.ListUsers200JSONResponse, 0, len(users))
	for _, u := range users {
		out = append(out, profile(u))
	}
	return out, nil
}

// checkModifiable refuses an admin acting on their own account, and re-reads
// the actor under accountMu: two admins disabling each other at once must not
// both succeed and leave no one able to sign in. The caller holds accountMu.
func (s *Server) checkModifiable(ctx context.Context, targetID string) (string, error) {
	actor := principalFrom(ctx).user.ID
	if _, err := s.activeUser(ctx, actor); err != nil {
		return "", err
	}
	if actor == targetID {
		return "", fail(http.StatusConflict, codeCannotModifySelf)
	}
	return actor, nil
}

// UpdateUser disables or enables a user, or sets their quota.
func (s *Server) UpdateUser(ctx context.Context, req oapi.UpdateUserRequestObject) (oapi.UpdateUserResponseObject, error) {
	if req.Body.QuotaBytes != nil && *req.Body.QuotaBytes < 0 {
		return nil, badRequest(codeInvalidQuota)
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	actor := principalFrom(ctx).user.ID
	if req.Body.Disabled != nil {
		var err error
		if actor, err = s.checkModifiable(ctx, req.Id); err != nil {
			return nil, err
		}
		if err := s.setDisabled(ctx, actor, req.Id, *req.Body.Disabled); err != nil {
			return nil, notFound(err)
		}
	}
	if req.Body.QuotaBytes != nil {
		if err := s.store.SetQuota(ctx, req.Id, *req.Body.QuotaBytes); err != nil {
			return nil, notFound(err)
		}
		s.audit(ctx, auditQuotaSet, actor, req.Id)
	}
	u, err := s.store.UserByID(ctx, req.Id)
	if err != nil {
		return nil, notFound(err)
	}
	return oapi.UpdateUser200JSONResponse(profile(u)), nil
}

func (s *Server) setDisabled(ctx context.Context, actor, target string, disabled bool) error {
	if !disabled {
		if err := s.store.EnableUser(ctx, target); err != nil {
			return err
		}
		s.audit(ctx, auditUserEnabled, actor, target)
		return nil
	}
	revoked, err := s.store.DisableUser(ctx, target, s.cfg.Now())
	if err != nil {
		return err
	}
	s.keys.Drop(revoked...)
	s.audit(ctx, auditUserDisabled, actor, target)
	return nil
}

// DeleteUser removes a user and everything that hangs off the account.
func (s *Server) DeleteUser(ctx context.Context, req oapi.DeleteUserRequestObject) (oapi.DeleteUserResponseObject, error) {
	if err := s.deleteUser(ctx, req.Id); err != nil {
		return nil, err
	}
	// After accountMu: a large drive takes a while to unlink, and sign-ins go on.
	s.drainRemovalsLogged(ctx)
	return oapi.DeleteUser204Response{}, nil
}

func (s *Server) deleteUser(ctx context.Context, id string) error {
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	actor, err := s.checkModifiable(ctx, id)
	if err != nil {
		return err
	}
	revoked, err := s.store.DeleteUser(ctx, id)
	if err != nil {
		return notFound(err)
	}
	s.keys.Drop(revoked...)
	s.audit(ctx, auditUserDeleted, actor, id)
	return nil
}

// notFound turns a missing record into its API error.
func notFound(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return fail(http.StatusNotFound, codeNotFound)
	}
	return err
}

// CreatePasswordReset issues a reset link. It is refused in end-to-end mode,
// where a new password would open nothing: the keys depend on the old one. A
// session alone is not enough, since the link takes over the account.
func (s *Server) CreatePasswordReset(ctx context.Context, req oapi.CreatePasswordResetRequestObject) (oapi.CreatePasswordResetResponseObject, error) {
	if *s.mode.Load() != oapi.ModeNone {
		return nil, fail(http.StatusConflict, codeWrongMode)
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	if _, err := s.verifyCurrentKey(ctx, req.Body.CurrentAuthKey); err != nil {
		return nil, err
	}
	if _, err := s.store.UserByID(ctx, req.Id); err != nil {
		return nil, notFound(err)
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	token := auth.NewToken()
	expires := s.cfg.Now().Add(passwordResetTTL)
	if err := s.store.CreatePasswordReset(ctx, auth.HashToken(token), req.Id, expires); err != nil {
		return nil, err
	}
	s.audit(ctx, auditResetIssued, principalFrom(ctx).user.ID, req.Id)
	return oapi.CreatePasswordReset201JSONResponse{
		Token:     token,
		Link:      settings.PublicURL + "/reset#" + token,
		ExpiresAt: expires,
	}, nil
}

// CompletePasswordReset burns a reset link and replaces the credentials. No key
// depends on them in this mode, so there is nothing else to re-wrap.
func (s *Server) CompletePasswordReset(ctx context.Context, req oapi.CompletePasswordResetRequestObject) (oapi.CompletePasswordResetResponseObject, error) {
	if err := s.checkAttempt(ctx); err != nil {
		return nil, err
	}
	if *s.mode.Load() != oapi.ModeNone {
		return nil, fail(http.StatusConflict, codeWrongMode)
	}
	if len(req.Body.AuthKey) != auth.AuthKeyLen {
		return nil, badRequest(codeInvalidAuthKey)
	}
	kdf, err := encodeKDF(req.Body.Kdf)
	if err != nil {
		return nil, err
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	userID, revoked, err := s.store.ConsumePasswordReset(ctx, auth.HashToken(req.Body.Token),
		store.CredentialUpdate{AuthKeyHash: auth.HashKey(req.Body.AuthKey), KDF: kdf}, s.cfg.Now())
	if errors.Is(err, store.ErrResetInvalid) {
		return nil, fail(http.StatusForbidden, codeResetInvalid)
	}
	if err != nil {
		return nil, err
	}
	s.keys.Drop(revoked...)
	s.audit(ctx, auditResetCompleted, userID, userID)
	return oapi.CompletePasswordReset204Response{}, nil
}

// GetSettings returns the server settings.
func (s *Server) GetSettings(ctx context.Context, _ oapi.GetSettingsRequestObject) (oapi.GetSettingsResponseObject, error) {
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	return oapi.GetSettings200JSONResponse(s.settingsView(ctx, settings)), nil
}

// UpdateSettings changes the settings it is given. The request type has no
// field for the mode, so one sent anyway goes nowhere.
func (s *Server) UpdateSettings(ctx context.Context, req oapi.UpdateSettingsRequestObject) (oapi.UpdateSettingsResponseObject, error) {
	in := req.Body
	if (in.Name != nil && !validName(*in.Name)) ||
		(in.DefaultQuotaBytes != nil && *in.DefaultQuotaBytes < 0) ||
		(in.Language != nil && !languagePattern.MatchString(*in.Language)) ||
		(in.TimeZone != nil && !timeZonePattern.MatchString(*in.TimeZone)) ||
		(in.PurgeGraceDays != nil && (*in.PurgeGraceDays < minPurgeGraceDays || *in.PurgeGraceDays > maxSettingDays)) ||
		(in.TrashRetentionDays != nil && (*in.TrashRetentionDays < 0 || *in.TrashRetentionDays > maxSettingDays)) {
		return nil, badRequest(codeInvalidSettings)
	}
	if err := s.checkGraceChange(ctx, in); err != nil {
		return nil, err
	}
	publicURL := in.PublicUrl
	if publicURL != nil {
		u, err := ParsePublicURL(*publicURL)
		if err != nil {
			return nil, badRequest(codeInvalidPublicURL)
		}
		publicURL = &u
	}
	settings, err := s.store.UpdateSettings(ctx, store.SettingsPatch{
		Name:               in.Name,
		PublicURL:          publicURL,
		DefaultQuotaBytes:  in.DefaultQuotaBytes,
		Language:           in.Language,
		TimeZone:           in.TimeZone,
		OpenSignup:         in.OpenSignup,
		PurgeGraceDays:     in.PurgeGraceDays,
		TrashRetentionDays: in.TrashRetentionDays,
	})
	if err != nil {
		return nil, err
	}
	s.audit(ctx, auditSettingsChanged, principalFrom(ctx).user.ID, "")
	return oapi.UpdateSettings200JSONResponse(s.settingsView(ctx, settings)), nil
}

// checkGraceChange asks for a current auth key to shorten the grace period. That
// period is what stands between a stolen session and the data, so an admin session
// alone must not be able to wear it down before purging.
func (s *Server) checkGraceChange(ctx context.Context, in *oapi.UpdateSettingsJSONRequestBody) error {
	if in.PurgeGraceDays == nil {
		return nil
	}
	current, err := s.store.Settings(ctx)
	if err != nil {
		return err
	}
	if *in.PurgeGraceDays >= current.PurgeGraceDays {
		return nil
	}
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	var key []byte
	if in.CurrentAuthKey != nil {
		key = *in.CurrentAuthKey
	}
	_, err = s.verifyCurrentKey(ctx, key)
	return err
}

// GetAdminHealth reports the state of the server's storage and its last backup.
func (s *Server) GetAdminHealth(ctx context.Context, _ oapi.GetAdminHealthRequestObject) (oapi.GetAdminHealthResponseObject, error) {
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	stats, err := s.store.Stats(ctx)
	if err != nil {
		return nil, err
	}
	return oapi.GetAdminHealth200JSONResponse{
		Version:         s.cfg.Version,
		Mode:            oapi.Mode(settings.Mode),
		Blobs:           stats.Blobs,
		StoredBytes:     stats.StoredBytes,
		Uploads:         stats.Uploads,
		ReservedBytes:   stats.ReservedBytes,
		PendingRemovals: stats.PendingRemovals,
		FreeBytes:       freeBytes(s.store.Dir()),
		LastBackupAt:    optionalTime(settings.LastBackupAt),
	}, nil
}

func (s *Server) settingsView(ctx context.Context, in store.Settings) oapi.ServerSettings {
	return oapi.ServerSettings{
		Name:               in.Name,
		PublicUrl:          in.PublicURL,
		DefaultQuotaBytes:  in.DefaultQuotaBytes,
		Language:           in.Language,
		TimeZone:           in.TimeZone,
		Mode:               oapi.Mode(in.Mode),
		OpenSignup:         in.OpenSignup,
		ProxyUntrusted:     s.proxyUntrusted(requestFrom(ctx)),
		PurgeGraceDays:     in.PurgeGraceDays,
		TrashRetentionDays: in.TrashRetentionDays,
	}
}
