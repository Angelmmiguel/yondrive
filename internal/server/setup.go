package server

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"syscall"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const auditSetupCompleted = "setup_completed"

// freeBytes returns the free space in a directory, if it can be told.
func freeBytes(dir string) *int64 {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(dir, &fs); err != nil {
		return nil
	}
	free := int64(fs.Bavail) * int64(fs.Bsize) //nolint:gosec // no filesystem holds 2^63 bytes
	return &free
}

// GetSetupInfo describes the environment to the wizard.
func (s *Server) GetSetupInfo(context.Context, oapi.GetSetupInfoRequestObject) (oapi.GetSetupInfoResponseObject, error) {
	dir, err := filepath.Abs(s.cfg.DataDir)
	if err != nil {
		dir = s.cfg.DataDir
	}
	info := oapi.GetSetupInfo200JSONResponse{DataDir: dir, Version: s.cfg.Version}
	info.FreeBytes = freeBytes(dir)
	if s.cfg.PublicURL != "" {
		info.PublicUrl = &s.cfg.PublicURL
	}
	return info, nil
}

// ValidateSetupURL normalises an address and says whether it needs a warning.
func (s *Server) ValidateSetupURL(_ context.Context, req oapi.ValidateSetupURLRequestObject) (oapi.ValidateSetupURLResponseObject, error) {
	u, err := ParsePublicURL(req.Body.Url)
	if err != nil {
		return nil, badRequest(codeInvalidPublicURL)
	}
	return oapi.ValidateSetupURL200JSONResponse{Url: u, Insecure: strings.HasPrefix(u, "http://")}, nil
}

// CompleteSetup stores the settings, creates the first admin and burns the
// token. The token check in guard ran before the lock; the store's transaction
// is what decides between two calls racing here, and it writes the mode once.
func (s *Server) CompleteSetup(ctx context.Context, req oapi.CompleteSetupRequestObject) (oapi.CompleteSetupResponseObject, error) {
	in := req.Body.Settings
	if in.Mode != oapi.ModeE2e && in.Mode != oapi.ModeNone {
		return nil, badRequest(codeInvalidMode)
	}
	publicURL, err := ParsePublicURL(in.PublicUrl)
	if err != nil {
		return nil, badRequest(codeInvalidPublicURL)
	}
	if !validName(in.Name) || in.DefaultQuotaBytes < 0 ||
		!languagePattern.MatchString(in.Language) || !timeZonePattern.MatchString(in.TimeZone) {
		return nil, badRequest(codeInvalidSettings)
	}
	admin, err := newUser(req.Body.Admin, in.Mode, s.cfg.Now())
	if err != nil {
		return nil, err
	}
	admin.Role = string(oapi.Admin)
	admin.QuotaBytes = in.DefaultQuotaBytes

	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	err = s.store.CompleteSetup(ctx, store.Settings{
		Mode:              string(in.Mode),
		Name:              in.Name,
		PublicURL:         publicURL,
		DefaultQuotaBytes: in.DefaultQuotaBytes,
		Language:          in.Language,
		TimeZone:          in.TimeZone,
	}, admin)
	if errors.Is(err, store.ErrAlreadyConfigured) {
		return nil, fail(http.StatusConflict, codeAlreadySetup)
	}
	if err != nil {
		return nil, err
	}
	s.setupHash = nil
	s.mode.Store(&in.Mode)
	s.audit(ctx, auditSetupCompleted, admin.ID, admin.ID)
	s.log.Info("setup completed", "mode", in.Mode, "remote", s.clientIP(requestFrom(ctx)))
	return oapi.CompleteSetup201JSONResponse{UserId: admin.ID}, nil
}
