package server

import (
	"context"
	"net/http"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// totpAttemptsPerWindow bounds guesses at a user's codes, whatever address they
// come from. It is keyed by user and reached only with the right auth key, so
// a stranger cannot use it to lock anyone out.
const totpAttemptsPerWindow = 5

// Audit actions for TOTP.
const (
	auditTOTPEnrolled     = "totp_enrolled"
	auditTOTPEnabled      = "totp_enabled"
	auditTOTPDisabled     = "totp_disabled"
	auditTOTPFailed       = "totp_failed"
	auditTOTPRecoveryUsed = "totp_recovery_code_used"
)

// checkSecondFactor verifies a TOTP code or a recovery code, burning either.
// The caller holds accountMu and has verified the auth key.
func (s *Server) checkSecondFactor(ctx context.Context, user store.User, code, recoveryCode *string) error {
	if !s.totpLimiter.Allow(user.ID) {
		return fail(http.StatusTooManyRequests, codeRateLimited)
	}
	switch {
	case code != nil:
		step, ok := auth.VerifyTOTP(user.TOTPSecret, *code, s.cfg.Now(), user.TOTPLastStep)
		if ok {
			consumed, err := s.store.ConsumeTOTPStep(ctx, user.ID, step)
			if err != nil {
				return err
			}
			if consumed {
				return nil
			}
		}
	case recoveryCode != nil:
		consumed, err := s.store.ConsumeRecoveryCode(ctx, user.ID, auth.HashRecoveryCode(*recoveryCode))
		if err != nil {
			return err
		}
		if consumed {
			s.audit(ctx, auditTOTPRecoveryUsed, user.ID, user.ID)
			return nil
		}
	}
	s.audit(ctx, auditTOTPFailed, user.ID, user.ID)
	return fail(http.StatusUnauthorized, codeTOTPInvalid)
}

// verifyCurrentKey re-reads the signed-in user and checks a current auth key,
// counting the attempt. The caller holds accountMu.
func (s *Server) verifyCurrentKey(ctx context.Context, key []byte) (store.User, error) {
	if err := s.checkAttempt(ctx); err != nil {
		return store.User{}, err
	}
	user, err := s.store.UserByID(ctx, principalFrom(ctx).user.ID)
	if err != nil {
		return store.User{}, err
	}
	if !auth.VerifyKey(key, user.AuthKeyHash, user.RecoveryAuthKeyHash) {
		s.audit(ctx, auditCredentialRejected, user.ID, user.ID)
		return store.User{}, fail(http.StatusUnauthorized, codeWrongCredential)
	}
	return user, nil
}

// EnrolTOTP stores a new secret, which has no effect until confirmed.
func (s *Server) EnrolTOTP(ctx context.Context, req oapi.EnrolTOTPRequestObject) (oapi.EnrolTOTPResponseObject, error) {
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.verifyCurrentKey(ctx, req.Body.CurrentAuthKey)
	if err != nil {
		return nil, err
	}
	if user.TOTPEnabled {
		return nil, fail(http.StatusConflict, codeTOTPAlreadyEnabled)
	}
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	secret := auth.NewTOTPSecret()
	if err := s.store.SetPendingTOTP(ctx, user.ID, secret); err != nil {
		return nil, err
	}
	s.audit(ctx, auditTOTPEnrolled, user.ID, user.ID)
	return oapi.EnrolTOTP200JSONResponse{
		Secret: auth.EncodeTOTPSecret(secret),
		Uri:    auth.TOTPURI(settings.Name, user.Username, secret),
	}, nil
}

// ConfirmTOTP puts the pending secret in force and returns the recovery codes.
func (s *Server) ConfirmTOTP(ctx context.Context, req oapi.ConfirmTOTPRequestObject) (oapi.ConfirmTOTPResponseObject, error) {
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.store.UserByID(ctx, principalFrom(ctx).user.ID)
	if err != nil {
		return nil, err
	}
	if user.TOTPEnabled {
		return nil, fail(http.StatusConflict, codeTOTPAlreadyEnabled)
	}
	if user.TOTPSecret == nil {
		return nil, fail(http.StatusConflict, codeTOTPNotPending)
	}
	if !s.totpLimiter.Allow(user.ID) {
		return nil, fail(http.StatusTooManyRequests, codeRateLimited)
	}
	now := s.cfg.Now()
	step, ok := auth.VerifyTOTP(user.TOTPSecret, req.Body.Code, now, 0)
	if !ok {
		return nil, fail(http.StatusUnauthorized, codeTOTPInvalid)
	}
	codes := auth.NewRecoveryCodes()
	hashes := make([][]byte, len(codes))
	for i, c := range codes {
		hashes[i] = auth.HashRecoveryCode(c)
	}
	if err := s.store.EnableTOTP(ctx, user.ID, step, now.Unix(), hashes); err != nil {
		return nil, err
	}
	s.audit(ctx, auditTOTPEnabled, user.ID, user.ID)
	return oapi.ConfirmTOTP200JSONResponse{RecoveryCodes: codes}, nil
}

// DisableTOTP removes the secret and recovery codes. It needs both factors, so
// a stolen session cannot weaken the account.
func (s *Server) DisableTOTP(ctx context.Context, req oapi.DisableTOTPRequestObject) (oapi.DisableTOTPResponseObject, error) {
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.verifyCurrentKey(ctx, req.Body.CurrentAuthKey)
	if err != nil {
		return nil, err
	}
	if !user.TOTPEnabled {
		return nil, fail(http.StatusConflict, codeTOTPNotEnabled)
	}
	if err := s.checkSecondFactor(ctx, user, req.Body.Code, req.Body.RecoveryCode); err != nil {
		return nil, err
	}
	if err := s.store.ClearTOTP(ctx, user.ID); err != nil {
		return nil, err
	}
	s.audit(ctx, auditTOTPDisabled, user.ID, user.ID)
	return oapi.DisableTOTP204Response{}, nil
}
