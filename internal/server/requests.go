package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const (
	auditRequestReceived = "request_upload_received"
	auditIncomingAdopted = "incoming_adopted"
	auditIncomingDeleted = "incoming_deleted"
)

// maxRequestMetadata bounds what a sender seals beside a file: its name, type,
// times, and a name and a message of their own. It is not charged until the file
// is adopted, so it stays small.
const maxRequestMetadata = 8 << 10

// requestUploadIdle is how long an upload through a request may go without a
// frame before it is dropped. Anyone with the address can start one, and each
// holds a place on the request until then.
const requestUploadIdle = time.Hour

// requestUploadAttemptsFactor is how many times the sign-in limit an address may
// start uploads through requests: enough for a folder of photos, not to fill an
// owner's disk with uploads that never finish.
const requestUploadAttemptsFactor = 3

// publicRequestView shows a request to someone who may send to it: the room it
// has left and nothing about where the files go.
func (s *Server) publicRequestView(l store.Link, sess linkSession) oapi.PublicRequest {
	now := s.cfg.Now()
	if sess.id == "" {
		sess = linkSession{linkID: l.ID, nodeID: l.NodeID, id: store.NewID(), deadline: now.Add(linkSessionLifetime)}
	}
	sess.expires = now.Add(linkTokenTTL)
	if sess.expires.After(sess.deadline) {
		sess.expires = sess.deadline
	}
	token := s.mintLinkToken(sess)
	suite := s.suite()
	out := oapi.PublicRequest{
		Id:             l.ID,
		State:          oapi.PublicRequestStateOpen,
		Suite:          &suite,
		PublicKey:      &l.PublicKey,
		Token:          &token,
		TokenExpiresAt: &sess.expires,
		ExpiresAt:      optionalTime(l.ExpiresAt),
		MaxFileSize:    optionalCount(l.MaxFileSize),
	}
	if l.FileLimit > 0 {
		left := max(l.FileLimit-l.FilesReceived, 0)
		out.FilesRemaining = &left
	}
	if l.BytesLimit > 0 {
		left := max(l.BytesLimit-l.BytesReceived, 0)
		out.BytesRemaining = &left
	}
	return out
}

// GetPublicRequest opens a request, or says what it takes to.
func (s *Server) GetPublicRequest(ctx context.Context, req oapi.GetPublicRequestRequestObject) (oapi.GetPublicRequestResponseObject, error) {
	if !s.linkOpenLimiter.Allow(s.rateLimitKey(requestFrom(ctx))) {
		return nil, fail(http.StatusTooManyRequests, codeRateLimited)
	}
	l, err := s.liveLink(ctx, req.Id, store.LinkKindRequest)
	if err != nil {
		return nil, err
	}
	var sess linkSession
	if req.Params.XLinkToken != nil {
		if parsed, ok := s.parseLinkToken(*req.Params.XLinkToken, l.ID, s.cfg.Now()); ok && parsed.nodeID == l.NodeID {
			sess = parsed
		}
	}
	if sess.id == "" && l.KDF != nil {
		if err := s.checkLinkAttempt(ctx, l.ID); err != nil {
			return nil, err
		}
		var kdf oapi.KDF
		if err := json.Unmarshal(l.KDF, &kdf); err != nil {
			return nil, err
		}
		return oapi.GetPublicRequest200JSONResponse(oapi.PublicRequest{
			Id: l.ID, State: oapi.PublicRequestStatePasswordRequired, Kdf: &kdf, ExpiresAt: optionalTime(l.ExpiresAt),
		}), nil
	}
	return oapi.GetPublicRequest200JSONResponse(s.publicRequestView(l, sess)), nil
}

// UnlockPublicRequest trades the auth key of a request's password for a token,
// with the same limits as a link's.
func (s *Server) UnlockPublicRequest(ctx context.Context, req oapi.UnlockPublicRequestRequestObject) (oapi.UnlockPublicRequestResponseObject, error) {
	if !blobs.ValidID(req.Id) {
		return nil, badRequest(codeInvalidID)
	}
	if err := s.checkLinkAttempt(ctx, req.Id); err != nil {
		return nil, err
	}
	l, err := s.liveLink(ctx, req.Id, store.LinkKindRequest)
	if err != nil {
		return nil, err
	}
	if l.KDF != nil && !auth.VerifyKey(req.Body.AuthKey, l.AuthHash, nil) {
		s.audit(ctx, auditLinkUnlockFailed, "", l.ID)
		return nil, fail(http.StatusUnauthorized, codeLinkPasswordInvalid)
	}
	if l.KDF != nil {
		s.audit(ctx, auditLinkUnlocked, "", l.ID)
	}
	return oapi.UnlockPublicRequest200JSONResponse(s.publicRequestView(l, linkSession{})), nil
}

// requestUpload loads an upload that came through this request. Any other
// answers the same as none at all.
func (s *Server) requestUpload(ctx context.Context, l store.Link, id string) (store.Upload, error) {
	if !blobs.ValidID(id) {
		return store.Upload{}, fail(http.StatusNotFound, codeNotFound)
	}
	u, err := s.store.UploadByID(ctx, id)
	if err != nil {
		return store.Upload{}, driveError(err)
	}
	if u.LinkID != l.ID {
		return store.Upload{}, fail(http.StatusNotFound, codeNotFound)
	}
	return u, nil
}

// requestUploadView shows an upload to its sender: the ids the file will have, and
// never the folder it goes to, which is the upload's own node.
func requestUploadView(u store.Upload, nodeID string, frames []int64) oapi.RequestUpload {
	return oapi.RequestUpload{
		Id:         u.ID,
		NodeId:     nodeID,
		VersionId:  u.VersionID,
		FrameCount: u.FrameCount,
		FrameSize:  u.FrameSize,
		StoredSize: u.StoredSize,
		Frames:     frames,
		CreatedAt:  u.CreatedAt,
	}
}

// CreateRequestUpload starts a file on its way through a request. As with any
// upload, the row comes first, then the file. The server chooses the ids, so that
// a sender cannot ask whether one is in use.
func (s *Server) CreateRequestUpload(ctx context.Context, req oapi.CreateRequestUploadRequestObject) (oapi.CreateRequestUploadResponseObject, error) {
	l, _, err := s.authorizeLink(ctx, req.Id, store.LinkKindRequest, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	if !s.requestUploadLimiter.Allow(s.rateLimitKey(requestFrom(ctx))) {
		return nil, fail(http.StatusTooManyRequests, codeRateLimited)
	}
	in := req.Body
	if err := s.checkSuite(in.Suite); err != nil {
		return nil, err
	}
	overhead := s.overhead()
	if _, ok := framingOf(in.FrameCount, in.FrameSize, in.StoredSize, overhead); !ok {
		return nil, badRequest(codeInvalidFraming)
	}
	id, nodeID := store.NewID(), store.NewID()
	u, err := s.store.CreateRequestUpload(ctx, l.ID, store.Incoming{
		ID:         nodeID,
		BlobID:     id,
		VersionID:  store.NewID(),
		Suite:      string(in.Suite),
		Size:       in.StoredSize - in.FrameCount*overhead,
		StoredSize: in.StoredSize,
		FrameCount: in.FrameCount,
		FrameSize:  in.FrameSize,
		CreatedAt:  s.cfg.Now(),
	})
	if err != nil {
		return nil, requestError(err)
	}
	if err := s.files.CreateUpload(id, in.StoredSize); err != nil {
		if derr := s.store.DeleteUpload(context.WithoutCancel(ctx), id); derr != nil {
			s.log.Error("upload row left behind", "error", derr)
		}
		return nil, driveError(err)
	}
	return oapi.CreateRequestUpload201JSONResponse(requestUploadView(u, nodeID, []int64{})), nil
}

// requestError turns what the store says about a request's limits into API errors.
func requestError(err error) error {
	switch {
	case errors.Is(err, store.ErrRequestFileTooLarge):
		return fail(http.StatusRequestEntityTooLarge, codeRequestFileTooLarge)
	case errors.Is(err, store.ErrRequestFiles):
		return fail(http.StatusConflict, codeRequestFilesReached)
	case errors.Is(err, store.ErrRequestBytes):
		return fail(http.StatusRequestEntityTooLarge, codeRequestBytesReached)
	}
	return driveError(err)
}

// GetRequestUpload reports which frames of an upload through a request have arrived.
func (s *Server) GetRequestUpload(ctx context.Context, req oapi.GetRequestUploadRequestObject) (oapi.GetRequestUploadResponseObject, error) {
	l, _, err := s.authorizeLink(ctx, req.Id, store.LinkKindRequest, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	u, err := s.requestUpload(ctx, l, req.UploadId)
	if err != nil {
		return nil, err
	}
	frames, err := s.store.UploadedFrames(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	item, err := s.store.IncomingByBlob(ctx, u.ID)
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.GetRequestUpload200JSONResponse(requestUploadView(u, item.ID, frames)), nil
}

// AbortRequestUpload drops an upload through a request, and gives back what it
// held of the quota and of the request.
func (s *Server) AbortRequestUpload(ctx context.Context, req oapi.AbortRequestUploadRequestObject) (oapi.AbortRequestUploadResponseObject, error) {
	l, _, err := s.authorizeLink(ctx, req.Id, store.LinkKindRequest, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	u, err := s.requestUpload(ctx, l, req.UploadId)
	if err != nil {
		return nil, err
	}
	if err := s.store.DeleteUpload(ctx, u.ID); err != nil {
		return nil, driveError(err)
	}
	s.drainRemovalsLogged(ctx)
	return oapi.AbortRequestUpload204Response{}, nil
}

// PutRequestFrame stores one frame of an upload through a request.
func (s *Server) PutRequestFrame(ctx context.Context, req oapi.PutRequestFrameRequestObject) (oapi.PutRequestFrameResponseObject, error) {
	l, _, err := s.authorizeLink(ctx, req.Id, store.LinkKindRequest, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	u, err := s.requestUpload(ctx, l, req.UploadId)
	if err != nil {
		return nil, err
	}
	if err := s.writeFrame(ctx, u, req.N, req.Params.XContentSHA256, req.Body); err != nil {
		return nil, err
	}
	return oapi.PutRequestFrame204Response{}, nil
}

// CommitRequestUpload hands a complete upload over to the request's owner, as an
// item that waits for them, with the node key and metadata its sender sealed. The
// sender learns nothing more. A commit of an upload already handed over answers the
// same again, so that a lost answer can be retried, and only that: `not_found`
// means that nothing arrived.
func (s *Server) CommitRequestUpload(ctx context.Context, req oapi.CommitRequestUploadRequestObject) (oapi.CommitRequestUploadResponseObject, error) {
	ctx = context.WithoutCancel(ctx)
	l, _, err := s.authorizeLink(ctx, req.Id, store.LinkKindRequest, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	in := req.Body
	if !s.checkSealed(in.SealedKey, grantLen) || len(in.SealedMetadata) < 1 || len(in.SealedMetadata) > maxRequestMetadata {
		return nil, badRequest(codeInvalidNode)
	}
	u, err := s.requestUpload(ctx, l, req.UploadId)
	if err != nil {
		if blobs.ValidID(req.UploadId) && s.handedOver(ctx, l, req.UploadId) {
			return oapi.CommitRequestUpload204Response{}, nil
		}
		return nil, err
	}
	err = s.store.CommitRequestUpload(ctx, u.ID, in.SealedKey, in.SealedMetadata, s.cfg.Now(),
		func(u store.Upload) error { return s.files.PlaceUpload(u.ID) })
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditRequestReceived, "", l.ID)
	return oapi.CommitRequestUpload204Response{}, nil
}

// handedOver reports whether an upload through this request has completed and
// waits for its owner.
func (s *Server) handedOver(ctx context.Context, l store.Link, uploadID string) bool {
	item, err := s.store.IncomingByBlob(ctx, uploadID)
	return err == nil && item.LinkID == l.ID && !item.CompletedAt.IsZero()
}

// ListIncoming returns a page of what has arrived for the caller, each item with
// its request's keys.
func (s *Server) ListIncoming(ctx context.Context, req oapi.ListIncomingRequestObject) (oapi.ListIncomingResponseObject, error) {
	after, err := idCursor(req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	items, err := s.store.ListIncoming(ctx, principalFrom(ctx).user.ID, after, limit+1)
	if err != nil {
		return nil, err
	}
	items, next := page(items, limit, func(in store.Incoming) string { return in.ID })
	links := map[string]store.Link{}
	out := oapi.IncomingPage{Items: make([]oapi.IncomingItem, 0, len(items)), NextCursor: next}
	for _, in := range items {
		l, ok := links[in.LinkID]
		if !ok {
			if l, err = s.store.LinkByID(ctx, in.LinkID); err != nil {
				return nil, err
			}
			links[in.LinkID] = l
		}
		out.Items = append(out.Items, oapi.IncomingItem{
			Id:               in.ID,
			LinkId:           in.LinkID,
			FolderId:         l.NodeID,
			Suite:            oapi.Suite(in.Suite),
			SealedKey:        in.SealedKey,
			SealedMetadata:   in.SealedMetadata,
			PublicKey:        l.PublicKey,
			SealedPrivateKey: l.OwnerSealedKey,
			VersionId:        in.VersionID,
			BlobId:           in.BlobID,
			Size:             in.Size,
			StoredSize:       in.StoredSize,
			FrameCount:       in.FrameCount,
			FrameSize:        in.FrameSize,
			FrameHashes:      in.FrameHashes,
			CreatedAt:        in.CreatedAt,
		})
	}
	return oapi.ListIncoming200JSONResponse(out), nil
}

// ownIncoming loads an item that has arrived for the caller. Anyone else's, and
// one still on its way, do not exist.
func (s *Server) ownIncoming(ctx context.Context, id string) (store.Incoming, error) {
	if !blobs.ValidID(id) {
		return store.Incoming{}, badRequest(codeInvalidID)
	}
	in, err := s.store.IncomingByID(ctx, id)
	if err != nil {
		return store.Incoming{}, driveError(err)
	}
	if in.OwnerID != principalFrom(ctx).user.ID || in.CompletedAt.IsZero() {
		return store.Incoming{}, fail(http.StatusNotFound, codeNotFound)
	}
	return in, nil
}

// DeleteIncoming throws an item away.
func (s *Server) DeleteIncoming(ctx context.Context, req oapi.DeleteIncomingRequestObject) (oapi.DeleteIncomingResponseObject, error) {
	in, err := s.ownIncoming(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if err := s.store.DeleteIncoming(ctx, in.ID); err != nil {
		return nil, driveError(err)
	}
	s.drainRemovalsLogged(ctx)
	s.audit(ctx, auditIncomingDeleted, in.OwnerID, in.ID)
	return oapi.DeleteIncoming204Response{}, nil
}

// AdoptIncoming puts an item in its request's folder, as a file whose first
// version the owner signs.
func (s *Server) AdoptIncoming(ctx context.Context, req oapi.AdoptIncomingRequestObject) (oapi.AdoptIncomingResponseObject, error) {
	in := req.Body
	if err := s.checkWrappedKey(in.WrappedKey); err != nil {
		return nil, err
	}
	if len(in.NameTag) != nameTagLen || !validMetadata(in.SealedMetadata) {
		return nil, badRequest(codeInvalidNode)
	}
	wantSignature := signatureLen
	if s.suite() == oapi.SuiteNone {
		wantSignature = 0
	}
	if len(in.Signature) != wantSignature || len(in.Manifest) < 1 || len(in.Manifest) > maxManifest {
		return nil, badRequest(codeInvalidCommit)
	}
	item, err := s.ownIncoming(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	node, _, err := s.store.AdoptIncoming(ctx, item.ID, store.Adoption{
		ParentGeneration: &in.ParentKeyGeneration,
		WrappedKey:       in.WrappedKey,
		NameTag:          in.NameTag,
		SealedMetadata:   in.SealedMetadata,
		Signature:        in.Signature,
		Manifest:         in.Manifest,
	}, s.cfg.Now())
	if errors.Is(err, store.ErrIncomingPending) {
		return nil, fail(http.StatusNotFound, codeNotFound)
	}
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditIncomingAdopted, item.OwnerID, item.ID)
	return oapi.AdoptIncoming201JSONResponse(ownerView(node)), nil
}
