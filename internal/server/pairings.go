package server

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"time"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Audit actions for pairings.
const (
	auditPairingStarted   = "pairing_started"
	auditPairingClaimed   = "pairing_claimed"
	auditPairingConfirmed = "pairing_confirmed"
	auditPairingCancelled = "pairing_cancelled"
)

const (
	// pairingTTL is how long a code may wait to be claimed and confirmed.
	pairingTTL = 5 * time.Minute
	// pairingPickupTTL is how long a device has to collect what was confirmed.
	pairingPickupTTL = 2 * time.Minute
	// pairingAttemptsFactor is how many times the sign-in limit an address may claim
	// and poll: a claim or a poll proves nothing by itself, and a device polling
	// every two seconds makes 30 a minute.
	pairingAttemptsFactor = 12
)

// The size of what a browser hands a device: a token hash, and a payload sealed
// to the device, at least the cipher's overhead (docs/CRYPTO.md section 22).
const (
	tokenHashLen      = 32
	minPairingPayload = 41
	maxPairingPayload = 2048
)

// StartPairing opens a pairing for the session or token that asks, after a
// current credential, as making a token needs one.
func (s *Server) StartPairing(ctx context.Context, req oapi.StartPairingRequestObject) (oapi.StartPairingResponseObject, error) {
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	user, err := s.verifyCurrentKey(ctx, req.Body.CurrentAuthKey)
	if err != nil {
		return nil, err
	}
	if err := s.checkDeviceLimit(ctx, user.ID); err != nil {
		return nil, err
	}
	p := principalFrom(ctx)
	now := s.cfg.Now()
	pairing := store.Pairing{
		ID:             store.NewID(),
		UserID:         user.ID,
		SessionHash:    p.sessionHash,
		CreatorTokenID: p.tokenID,
		State:          store.PairingOpen,
		CreatedAt:      now,
		ExpiresAt:      now.Add(pairingTTL),
	}
	if err := s.store.CreatePairing(ctx, pairing); err != nil {
		return nil, err
	}
	s.audit(ctx, auditPairingStarted, user.ID, pairing.ID)
	return oapi.StartPairing201JSONResponse(pairingView(pairing, nil)), nil
}

// GetPairing shows a pairing to the session or token that started it.
func (s *Server) GetPairing(ctx context.Context, req oapi.GetPairingRequestObject) (oapi.GetPairingResponseObject, error) {
	pairing, err := s.ownPairing(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if !s.cfg.Now().Before(pairing.ExpiresAt) {
		return nil, fail(http.StatusGone, codePairingExpired)
	}
	var token *store.Token
	if pairing.TokenID != "" {
		tokens, err := s.store.ListTokens(ctx, pairing.UserID)
		if err != nil {
			return nil, err
		}
		for i := range tokens {
			if tokens[i].ID == pairing.TokenID {
				token = &tokens[i]
			}
		}
	}
	return oapi.GetPairing200JSONResponse(pairingView(pairing, token)), nil
}

// ConfirmPairing stores the device's token by the hash the browser sends, and
// the payload the browser sealed to the device, which the server cannot open.
// It runs under the account lock, as every other way of making a token does.
func (s *Server) ConfirmPairing(ctx context.Context, req oapi.ConfirmPairingRequestObject) (oapi.ConfirmPairingResponseObject, error) {
	s.accountMu.Lock()
	defer s.accountMu.Unlock()
	pairing, err := s.ownPairing(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	now := s.cfg.Now()
	if err := confirmable(pairing, now); err != nil {
		return nil, err
	}
	n := len(req.Body.SealedPayload)
	if len(req.Body.TokenHash) != tokenHashLen || n < minPairingPayload || n > maxPairingPayload {
		return nil, badRequest(codeInvalidPairing)
	}
	if err := s.checkDeviceLimit(ctx, pairing.UserID); err != nil {
		return nil, err
	}
	token := store.Token{
		ID:        store.NewID(),
		UserID:    pairing.UserID,
		Name:      pairing.DeviceName,
		Platform:  pairing.DevicePlatform,
		Origin:    store.TokenOriginPairing,
		Hash:      req.Body.TokenHash,
		CreatedAt: now,
	}
	_, err = s.store.ConfirmPairing(ctx, pairing.ID, token, req.Body.SealedPayload, now, pairingPickupTTL)
	switch {
	case errors.Is(err, store.ErrTokenHashTaken):
		return nil, badRequest(codeInvalidPairing)
	case errors.Is(err, store.ErrPairingState):
		// Cancelled or expired since it was read.
		return nil, fail(http.StatusGone, codePairingExpired)
	case err != nil:
		return nil, err
	}
	s.audit(ctx, auditPairingConfirmed, pairing.UserID, pairing.ID)
	s.audit(ctx, auditTokenCreated, pairing.UserID, token.ID)
	return oapi.ConfirmPairing200JSONResponse(tokenView(token, "")), nil
}

// confirmable says why a pairing cannot be confirmed at now, if it cannot.
func confirmable(p store.Pairing, now time.Time) error {
	switch {
	case !now.Before(p.ExpiresAt):
		return fail(http.StatusGone, codePairingExpired)
	case p.State == store.PairingOpen:
		return fail(http.StatusConflict, codePairingNotClaimed)
	case p.State == store.PairingConfirmed:
		return fail(http.StatusConflict, codePairingConfirmed)
	}
	return nil
}

// CancelPairing ends a pairing, and the token it made if it was confirmed: the
// device may or may not have collected it.
func (s *Server) CancelPairing(ctx context.Context, req oapi.CancelPairingRequestObject) (oapi.CancelPairingResponseObject, error) {
	pairing, err := s.ownPairing(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	tokenID, err := s.store.DeletePairing(ctx, pairing.UserID, pairing.ID)
	if err != nil {
		return nil, notFound(err)
	}
	s.audit(ctx, auditPairingCancelled, pairing.UserID, pairing.ID)
	if tokenID != "" {
		s.audit(ctx, auditTokenRevoked, pairing.UserID, tokenID)
	}
	return oapi.CancelPairing204Response{}, nil
}

// ownPairing reads a pairing that the caller's own session or token started.
// Any other answers not_found, another session of the same user included: it
// does not hold the browser's key, and must not confirm what it did not start.
func (s *Server) ownPairing(ctx context.Context, id string) (store.Pairing, error) {
	if !blobs.ValidID(id) {
		return store.Pairing{}, badRequest(codeInvalidID)
	}
	pairing, err := s.store.PairingByID(ctx, id)
	if err != nil {
		return store.Pairing{}, notFound(err)
	}
	p := principalFrom(ctx)
	mine := pairing.UserID == p.user.ID
	if p.sessionHash != nil {
		mine = mine && subtle.ConstantTimeCompare(pairing.SessionHash, p.sessionHash) == 1
	} else {
		mine = mine && pairing.CreatorTokenID != "" && pairing.CreatorTokenID == p.tokenID
	}
	if !mine {
		return store.Pairing{}, fail(http.StatusNotFound, codeNotFound)
	}
	return pairing, nil
}

// ClaimPairing records the device that scanned a code. Anyone may call it: what
// it takes is a key that the browser's confirmation then has to vouch for.
func (s *Server) ClaimPairing(ctx context.Context, req oapi.ClaimPairingRequestObject) (oapi.ClaimPairingResponseObject, error) {
	if err := s.checkPairingAttempt(ctx, req.Id); err != nil {
		return nil, err
	}
	if !validName(req.Body.Name) {
		return nil, badRequest(codeInvalidTokenName)
	}
	platform, err := platformOf(req.Body.Platform)
	if err != nil {
		return nil, err
	}
	if len(req.Body.PublicKey) != publicKeyLen || subtle.ConstantTimeCompare(req.Body.PublicKey, make([]byte, publicKeyLen)) == 1 {
		return nil, badRequest(codeInvalidPairing)
	}
	pairing, err := s.store.ClaimPairing(ctx, req.Id, req.Body.PublicKey, req.Body.Name, platform, s.cfg.Now())
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil, fail(http.StatusNotFound, codePairingInvalid)
	case errors.Is(err, store.ErrPairingClaimed):
		return nil, fail(http.StatusConflict, codePairingClaimed)
	case err != nil:
		return nil, err
	}
	s.audit(ctx, auditPairingClaimed, "", pairing.ID)
	return oapi.ClaimPairing200JSONResponse(pickupView(pairing)), nil
}

// PollPairing shows a pairing to the device, with the sealed payload once the
// browser has confirmed. The row stays, so that a device may retry, until it
// expires.
func (s *Server) PollPairing(ctx context.Context, req oapi.PollPairingRequestObject) (oapi.PollPairingResponseObject, error) {
	if err := s.checkPairingAttempt(ctx, req.Id); err != nil {
		return nil, err
	}
	pairing, err := s.store.PairingByID(ctx, req.Id)
	if errors.Is(err, store.ErrNotFound) || (err == nil && !s.cfg.Now().Before(pairing.ExpiresAt)) {
		return nil, fail(http.StatusNotFound, codePairingInvalid)
	}
	if err != nil {
		return nil, err
	}
	if pairing.State == store.PairingConfirmed {
		// What is served is marked collected in the same statement, so that a token
		// whose secret went out is never swept as one nobody collected.
		pairing, err = s.store.CollectPairing(ctx, pairing.ID, s.cfg.Now())
		if errors.Is(err, store.ErrNotFound) {
			return nil, fail(http.StatusNotFound, codePairingInvalid)
		}
		if err != nil {
			return nil, err
		}
	}
	return oapi.PollPairing200JSONResponse(pickupView(pairing)), nil
}

// checkPairingAttempt counts a device's call against its address. An id of the
// wrong shape gets the answer of any other code these routes will not act on.
func (s *Server) checkPairingAttempt(ctx context.Context, id string) error {
	if !s.pairingLimiter.Allow(s.rateLimitKey(requestFrom(ctx))) {
		return fail(http.StatusTooManyRequests, codeRateLimited)
	}
	if !blobs.ValidID(id) {
		return fail(http.StatusNotFound, codePairingInvalid)
	}
	return nil
}

func pairingView(p store.Pairing, token *store.Token) oapi.Pairing {
	v := oapi.Pairing{Id: p.ID, Status: oapi.PairingStatus(p.State), ExpiresAt: p.ExpiresAt}
	if p.State != store.PairingOpen {
		v.Device = &oapi.PairingDevice{Name: p.DeviceName, PublicKey: p.DevicePublicKey}
		if p.DevicePlatform != "" {
			platform := oapi.DevicePlatform(p.DevicePlatform)
			v.Device.Platform = &platform
		}
	}
	if token != nil {
		view := tokenView(*token, "")
		v.Token = &view
	}
	return v
}

func pickupView(p store.Pairing) oapi.PairingPickup {
	v := oapi.PairingPickup{Status: oapi.PairingStatus(p.State), ExpiresAt: p.ExpiresAt}
	if p.SealedPayload != nil {
		v.SealedPayload = &p.SealedPayload
	}
	return v
}
