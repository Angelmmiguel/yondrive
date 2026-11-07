package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const (
	// linkTokenTTL is how long a link token lasts. A client renews it as it goes.
	linkTokenTTL = 15 * time.Minute
	// linkSessionLifetime is how long renewing can carry on. A session is what a
	// download limit counts within, so it must end for a file to count again.
	linkSessionLifetime = 24 * time.Hour
)

const (
	auditLinkCreated      = "link_created"
	auditLinkRevoked      = "link_revoked"
	auditLinkDeleted      = "link_deleted"
	auditLinkUnlocked     = "link_unlocked"
	auditLinkUnlockFailed = "link_unlock_failed"
)

func deriveLinkTokenKey(secret []byte) []byte {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte("yondrive/link-token-key/v1"))
	return mac.Sum(nil)
}

// linkSession is what a link token says: which link, down from which node, and
// until when. Everything else about the link is read again on each request.
type linkSession struct {
	linkID, nodeID, id string
	expires, deadline  time.Time
}

const linkTokenVersion = "v1"

func (s *Server) signLinkToken(payload string) string {
	mac := hmac.New(sha256.New, s.linkTokenKey)
	_, _ = mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) mintLinkToken(sess linkSession) string {
	payload := strings.Join([]string{linkTokenVersion, sess.linkID, sess.nodeID, sess.id,
		strconv.FormatInt(sess.expires.Unix(), 10), strconv.FormatInt(sess.deadline.Unix(), 10)}, ".")
	return payload + "." + s.signLinkToken(payload)
}

// parseLinkToken returns the session of a token that this server signed for this
// link and that has not expired.
func (s *Server) parseLinkToken(token, linkID string, now time.Time) (linkSession, bool) {
	payload, mac, found := cutLast(token, ".")
	if !found || !hmac.Equal([]byte(mac), []byte(s.signLinkToken(payload))) {
		return linkSession{}, false
	}
	parts := strings.Split(payload, ".")
	if len(parts) != 6 || parts[0] != linkTokenVersion || parts[1] != linkID {
		return linkSession{}, false
	}
	expires, err := strconv.ParseInt(parts[4], 10, 64)
	if err != nil {
		return linkSession{}, false
	}
	deadline, err := strconv.ParseInt(parts[5], 10, 64)
	if err != nil {
		return linkSession{}, false
	}
	sess := linkSession{linkID: parts[1], nodeID: parts[2], id: parts[3], expires: time.Unix(expires, 0).UTC(), deadline: time.Unix(deadline, 0).UTC()}
	if !now.Before(sess.expires) {
		return linkSession{}, false
	}
	return sess, true
}

func cutLast(s, sep string) (before, after string, found bool) {
	i := strings.LastIndex(s, sep)
	if i < 0 {
		return "", "", false
	}
	return s[:i], s[i+len(sep):], true
}

// linkView shows a link to the user who made it.
func linkView(l store.Link) oapi.Link {
	out := oapi.Link{
		Id:             l.ID,
		NodeId:         l.NodeID,
		Role:           oapi.LinkRole(l.Role),
		KeyGeneration:  l.KeyGeneration,
		SealedKey:      l.SealedKey,
		OwnerSealedKey: l.OwnerSealedKey,
		HasPassword:    l.KDF != nil,
		DownloadCount:  l.DownloadCount,
		ExpiresAt:      optionalTime(l.ExpiresAt),
		RevokedAt:      optionalTime(l.RevokedAt),
		CreatedAt:      l.CreatedAt,
	}
	if l.DownloadLimit > 0 {
		out.DownloadLimit = &l.DownloadLimit
	}
	return out
}

// checkLinkPassword validates the password of a new link and fills in what is
// stored of it.
func (s *Server) checkLinkPassword(in *oapi.LinkPassword, l *store.Link) error {
	if in == nil {
		return nil
	}
	kdf, err := encodeKDF(in.Kdf)
	if err != nil {
		return err
	}
	if len(in.AuthKey) != auth.AuthKeyLen {
		return badRequest(codeInvalidLink)
	}
	var wrapped []byte
	if in.WrappedKey != nil {
		wrapped = *in.WrappedKey
	}
	if !s.checkSealed(wrapped, sealedKeyLen) {
		return badRequest(codeInvalidLink)
	}
	if len(wrapped) > 0 {
		l.PasswordWrappedKey = wrapped
	}
	l.KDF, l.AuthHash = kdf, auth.HashKey(in.AuthKey)
	return nil
}

// CreateLink makes a public link to a node of the caller's.
func (s *Server) CreateLink(ctx context.Context, req oapi.CreateLinkRequestObject) (oapi.CreateLinkResponseObject, error) {
	in := req.Body
	if !blobs.ValidID(in.Id) {
		return nil, badRequest(codeInvalidID)
	}
	now := s.cfg.Now()
	if !in.Role.Valid() || !s.checkSealed(in.SealedKey, sealedKeyLen) || !s.checkSealed(in.OwnerSealedKey, sealedKeyLen) {
		return nil, badRequest(codeInvalidLink)
	}
	l := store.Link{
		ID:             in.Id,
		NodeID:         in.NodeId,
		OwnerID:        principalFrom(ctx).user.ID,
		Role:           string(in.Role),
		KeyGeneration:  in.KeyGeneration,
		SealedKey:      in.SealedKey,
		OwnerSealedKey: in.OwnerSealedKey,
		CreatedAt:      now,
	}
	if in.ExpiresAt != nil {
		if !in.ExpiresAt.After(now) {
			return nil, badRequest(codeInvalidLink)
		}
		l.ExpiresAt = *in.ExpiresAt
	}
	if in.DownloadLimit != nil {
		if *in.DownloadLimit < 1 {
			return nil, badRequest(codeInvalidLink)
		}
		l.DownloadLimit = *in.DownloadLimit
	}
	if err := s.checkLinkPassword(in.Password, &l); err != nil {
		return nil, err
	}
	if _, err := s.authorizeNode(ctx, in.NodeId, permOwn); err != nil {
		return nil, err
	}
	created, err := s.store.CreateLink(ctx, l)
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditLinkCreated, l.OwnerID, created.ID)
	return oapi.CreateLink201JSONResponse(linkView(created)), nil
}

// ListLinks returns a page of the caller's links.
func (s *Server) ListLinks(ctx context.Context, req oapi.ListLinksRequestObject) (oapi.ListLinksResponseObject, error) {
	after, err := idCursor(req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	links, err := s.store.ListLinksByOwner(ctx, principalFrom(ctx).user.ID, after, limit+1)
	if err != nil {
		return nil, err
	}
	links, next := page(links, limit, func(l store.Link) string { return l.ID })
	out := oapi.LinkPage{Items: make([]oapi.LinkedNode, 0, len(links)), NextCursor: next}
	for _, l := range links {
		n, err := s.store.NodeByID(ctx, l.NodeID)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, oapi.LinkedNode{Link: linkView(l), Node: ownerView(n)})
	}
	return oapi.ListLinks200JSONResponse(out), nil
}

// ownLink loads a link of the caller's. Anyone else's does not exist.
func (s *Server) ownLink(ctx context.Context, id string) (store.Link, error) {
	if !blobs.ValidID(id) {
		return store.Link{}, badRequest(codeInvalidID)
	}
	l, err := s.store.LinkByID(ctx, id)
	if err != nil {
		return store.Link{}, driveError(err)
	}
	if l.OwnerID != principalFrom(ctx).user.ID {
		return store.Link{}, fail(http.StatusNotFound, codeNotFound)
	}
	return l, nil
}

// RevokeLink ends a link and keeps it listed.
func (s *Server) RevokeLink(ctx context.Context, req oapi.RevokeLinkRequestObject) (oapi.RevokeLinkResponseObject, error) {
	l, err := s.ownLink(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	l, err = s.store.RevokeLink(ctx, l.ID, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditLinkRevoked, l.OwnerID, l.ID)
	return oapi.RevokeLink200JSONResponse(linkView(l)), nil
}

// DeleteLink forgets a link.
func (s *Server) DeleteLink(ctx context.Context, req oapi.DeleteLinkRequestObject) (oapi.DeleteLinkResponseObject, error) {
	l, err := s.ownLink(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if err := s.store.DeleteLink(ctx, l.ID); err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditLinkDeleted, l.OwnerID, l.ID)
	return oapi.DeleteLink204Response{}, nil
}

// liveLink loads a link anyone may use now. A link whose owner cannot sign in, or
// whose node is in the trash, is as good as not there.
func (s *Server) liveLink(ctx context.Context, id string) (store.Link, error) {
	if !blobs.ValidID(id) {
		return store.Link{}, badRequest(codeInvalidID)
	}
	l, err := s.store.LinkByID(ctx, id)
	if err != nil {
		return store.Link{}, driveError(err)
	}
	if !l.RevokedAt.IsZero() {
		return store.Link{}, fail(http.StatusGone, codeLinkRevoked)
	}
	if !l.ExpiresAt.IsZero() && !s.cfg.Now().Before(l.ExpiresAt) {
		return store.Link{}, fail(http.StatusGone, codeLinkExpired)
	}
	owner, err := s.store.UserByID(ctx, l.OwnerID)
	if err != nil {
		return store.Link{}, driveError(err)
	}
	hidden, err := s.store.NodeInTrash(ctx, l.NodeID)
	if err != nil {
		return store.Link{}, err
	}
	if owner.Disabled || hidden {
		return store.Link{}, fail(http.StatusNotFound, codeNotFound)
	}
	return l, nil
}

// authorizeLink checks a request's link token against a link that is live now.
// Nothing else counts: not a cookie, not a bearer token.
func (s *Server) authorizeLink(ctx context.Context, id string, token *string) (store.Link, linkSession, error) {
	if !blobs.ValidID(id) {
		return store.Link{}, linkSession{}, badRequest(codeInvalidID)
	}
	if token == nil || *token == "" {
		return store.Link{}, linkSession{}, fail(http.StatusUnauthorized, codeLinkTokenRequired)
	}
	sess, ok := s.parseLinkToken(*token, id, s.cfg.Now())
	if !ok {
		return store.Link{}, linkSession{}, fail(http.StatusUnauthorized, codeLinkTokenInvalid)
	}
	l, err := s.liveLink(ctx, id)
	if err != nil {
		return store.Link{}, linkSession{}, err
	}
	if sess.nodeID != l.NodeID {
		return store.Link{}, linkSession{}, fail(http.StatusUnauthorized, codeLinkTokenInvalid)
	}
	return l, sess, nil
}

// checkLinkAttempt counts an attempt at a link's password.
func (s *Server) checkLinkAttempt(ctx context.Context, linkID string) error {
	byAddress := s.linkPasswordLimiter.Allow(s.rateLimitKey(requestFrom(ctx)))
	byLink := s.linkLimiter.Allow(linkID)
	if !byAddress || !byLink {
		return fail(http.StatusTooManyRequests, codeRateLimited)
	}
	return nil
}

func linkExhausted(l store.Link) bool {
	return l.DownloadLimit > 0 && l.DownloadCount >= l.DownloadLimit
}

func publicNodeView(n store.Node, l store.Link) oapi.PublicNode {
	out := oapi.PublicNode{
		Id:             n.ID,
		ParentId:       optional(n.ParentID),
		Kind:           oapi.NodeKind(n.Kind),
		Suite:          oapi.Suite(n.Suite),
		SealedMetadata: n.SealedMetadata,
		WrappedKey:     n.WrappedKey,
		KeyGeneration:  n.KeyGeneration,
		CurrentVersion: optional(n.CurrentVersion),
		ThumbBlobId:    optional(n.ThumbBlobID),
		CreatedAt:      n.CreatedAt,
		UpdatedAt:      n.UpdatedAt,
	}
	if n.ID == l.NodeID {
		out.ParentId, out.WrappedKey = nil, []byte{}
	}
	return out
}

// openLink answers with the node and a token, for a session that is new or going on.
func (s *Server) openLink(ctx context.Context, l store.Link, sess linkSession) (oapi.PublicLink, error) {
	n, err := s.store.NodeByID(ctx, l.NodeID)
	if err != nil {
		return oapi.PublicLink{}, driveError(err)
	}
	now := s.cfg.Now()
	if sess.id == "" {
		sess = linkSession{linkID: l.ID, nodeID: l.NodeID, id: store.NewID(), deadline: now.Add(linkSessionLifetime)}
	}
	sess.expires = now.Add(linkTokenTTL)
	if sess.expires.After(sess.deadline) {
		sess.expires = sess.deadline
	}
	node := publicNodeView(n, l)
	token := s.mintLinkToken(sess)
	out := oapi.PublicLink{
		Id:             l.ID,
		State:          oapi.Open,
		Node:           &node,
		SealedKey:      &l.SealedKey,
		KeyGeneration:  &l.KeyGeneration,
		Token:          &token,
		TokenExpiresAt: &sess.expires,
		ExpiresAt:      optionalTime(l.ExpiresAt),
	}
	if l.PasswordWrappedKey != nil {
		out.PasswordWrappedKey = &l.PasswordWrappedKey
	}
	if l.DownloadLimit > 0 {
		remaining := max(l.DownloadLimit-l.DownloadCount, 0)
		out.DownloadsRemaining = &remaining
	}
	return out, nil
}

// GetPublicLink opens a link, or says what it takes to.
func (s *Server) GetPublicLink(ctx context.Context, req oapi.GetPublicLinkRequestObject) (oapi.GetPublicLinkResponseObject, error) {
	if !s.linkOpenLimiter.Allow(s.rateLimitKey(requestFrom(ctx))) {
		return nil, fail(http.StatusTooManyRequests, codeRateLimited)
	}
	l, err := s.liveLink(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	var sess linkSession
	if req.Params.XLinkToken != nil {
		if parsed, ok := s.parseLinkToken(*req.Params.XLinkToken, l.ID, s.cfg.Now()); ok && parsed.nodeID == l.NodeID {
			sess = parsed
		}
	}
	if sess.id == "" {
		if linkExhausted(l) {
			return nil, fail(http.StatusGone, codeLinkLimitReached)
		}
		if l.KDF != nil {
			if err := s.checkLinkAttempt(ctx, l.ID); err != nil {
				return nil, err
			}
			var kdf oapi.KDF
			if err := json.Unmarshal(l.KDF, &kdf); err != nil {
				return nil, err
			}
			return oapi.GetPublicLink200JSONResponse(oapi.PublicLink{Id: l.ID, State: oapi.PasswordRequired, Kdf: &kdf, ExpiresAt: optionalTime(l.ExpiresAt)}), nil
		}
	}
	out, err := s.openLink(ctx, l, sess)
	if err != nil {
		return nil, err
	}
	return oapi.GetPublicLink200JSONResponse(out), nil
}

// UnlockPublicLink trades the auth key of a link's password for a token and, in
// end-to-end mode, the wrapped link key. Nothing that could be attacked offline
// leaves the server before this, so guessing goes through the limits, as at sign-in.
func (s *Server) UnlockPublicLink(ctx context.Context, req oapi.UnlockPublicLinkRequestObject) (oapi.UnlockPublicLinkResponseObject, error) {
	if !blobs.ValidID(req.Id) {
		return nil, badRequest(codeInvalidID)
	}
	if err := s.checkLinkAttempt(ctx, req.Id); err != nil {
		return nil, err
	}
	l, err := s.liveLink(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if linkExhausted(l) {
		return nil, fail(http.StatusGone, codeLinkLimitReached)
	}
	if l.KDF != nil && !auth.VerifyKey(req.Body.AuthKey, l.AuthHash, nil) {
		s.audit(ctx, auditLinkUnlockFailed, "", l.ID)
		return nil, fail(http.StatusUnauthorized, codeLinkPasswordInvalid)
	}
	if l.KDF != nil {
		s.audit(ctx, auditLinkUnlocked, "", l.ID)
	}
	out, err := s.openLink(ctx, l, linkSession{})
	if err != nil {
		return nil, err
	}
	return oapi.UnlockPublicLink200JSONResponse(out), nil
}

// linkNode loads a node at or under a link's. Everything else, in the trash or
// outside the subtree or nowhere at all, answers the same.
func (s *Server) linkNode(ctx context.Context, l store.Link, id string) (store.Node, error) {
	if !blobs.ValidID(id) {
		return store.Node{}, badRequest(codeInvalidID)
	}
	visible, err := s.store.NodeVisibleUnder(ctx, l.NodeID, id)
	if err != nil {
		return store.Node{}, err
	}
	if !visible {
		return store.Node{}, fail(http.StatusNotFound, codeNotFound)
	}
	n, err := s.store.NodeByID(ctx, id)
	if err != nil {
		return store.Node{}, driveError(err)
	}
	return n, nil
}

// GetPublicNode returns a node under a link.
func (s *Server) GetPublicNode(ctx context.Context, req oapi.GetPublicNodeRequestObject) (oapi.GetPublicNodeResponseObject, error) {
	l, _, err := s.authorizeLink(ctx, req.Id, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	n, err := s.linkNode(ctx, l, req.NodeId)
	if err != nil {
		return nil, err
	}
	return oapi.GetPublicNode200JSONResponse(publicNodeView(n, l)), nil
}

// ListPublicChildren returns a page of a folder's children under a link.
func (s *Server) ListPublicChildren(ctx context.Context, req oapi.ListPublicChildrenRequestObject) (oapi.ListPublicChildrenResponseObject, error) {
	l, _, err := s.authorizeLink(ctx, req.Id, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	n, err := s.linkNode(ctx, l, req.NodeId)
	if err != nil {
		return nil, err
	}
	after, err := idCursor(req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	nodes, err := s.store.ListChildren(ctx, n.ID, after, limit+1)
	if err != nil {
		return nil, err
	}
	nodes, next := page(nodes, limit, func(n store.Node) string { return n.ID })
	out := oapi.PublicNodePage{Nodes: make([]oapi.PublicNode, 0, len(nodes)), NextCursor: next}
	for _, child := range nodes {
		out.Nodes = append(out.Nodes, publicNodeView(child, l))
	}
	return oapi.ListPublicChildren200JSONResponse(out), nil
}

// GetPublicVersion returns a file's current version under a link. The signer is
// their key and nothing else about them.
func (s *Server) GetPublicVersion(ctx context.Context, req oapi.GetPublicVersionRequestObject) (oapi.GetPublicVersionResponseObject, error) {
	l, _, err := s.authorizeLink(ctx, req.Id, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	n, err := s.linkNode(ctx, l, req.NodeId)
	if err != nil {
		return nil, err
	}
	if n.CurrentVersion == "" {
		return nil, fail(http.StatusNotFound, codeNotFound)
	}
	v, err := s.store.VersionByID(ctx, n.ID, n.CurrentVersion)
	if err != nil {
		return nil, driveError(err)
	}
	out := oapi.PublicVersion{
		Id:               v.ID,
		NodeId:           v.NodeID,
		BlobId:           v.BlobID,
		Suite:            oapi.Suite(v.Suite),
		ContentVersionId: v.ContentVersionID,
		KeyGeneration:    v.KeyGeneration,
		KeyChain:         keyChainView(v.KeyChain),
		StoredSize:       v.StoredSize,
		FrameCount:       v.FrameCount,
		FrameSize:        v.FrameSize,
		FrameHashes:      v.FrameHashes,
		Signature:        v.Signature,
		Manifest:         v.Manifest,
	}
	author, err := s.store.UserByID(ctx, v.ContentAuthorID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, err
	}
	if err == nil && author.PublicKeyEd25519 != nil {
		out.AuthorPublicKey = &author.PublicKeyEd25519
	}
	return oapi.GetPublicVersion200JSONResponse(out), nil
}

// linkBlob loads a stored file a link shows: a node's current version or its
// thumbnail, at or under the link's node. It reports whether the file counts
// against the download limit.
func (s *Server) linkBlob(ctx context.Context, l store.Link, id string) (store.Blob, bool, error) {
	if !blobs.ValidID(id) {
		return store.Blob{}, false, badRequest(codeInvalidID)
	}
	b, err := s.store.BlobByID(ctx, id)
	if err != nil {
		return store.Blob{}, false, driveError(err)
	}
	notFound := fail(http.StatusNotFound, codeNotFound)
	if b.NodeID == "" {
		return store.Blob{}, false, notFound
	}
	n, err := s.linkNode(ctx, l, b.NodeID)
	if err != nil {
		return store.Blob{}, false, err
	}
	switch b.Kind {
	case store.BlobThumb:
		return b, false, nil
	case store.BlobContent:
		if n.CurrentVersion == "" {
			return store.Blob{}, false, notFound
		}
		v, err := s.store.VersionByID(ctx, n.ID, n.CurrentVersion)
		if err != nil {
			return store.Blob{}, false, driveError(err)
		}
		if v.BlobID != b.ID {
			return store.Blob{}, false, notFound
		}
		return b, true, nil
	}
	return store.Blob{}, false, notFound
}

// GetPublicBlob serves a stored file under a link. Content is counted before the
// first byte goes, in a transaction, so a limit holds however many ask at once.
func (s *Server) GetPublicBlob(ctx context.Context, req oapi.GetPublicBlobRequestObject) (oapi.GetPublicBlobResponseObject, error) {
	l, sess, err := s.authorizeLink(ctx, req.Id, req.Params.XLinkToken)
	if err != nil {
		return nil, err
	}
	b, counts, err := s.linkBlob(ctx, l, req.BlobId)
	if err != nil {
		return nil, err
	}
	f, err := s.files.Open(b.ID)
	if err != nil {
		return nil, driveError(err)
	}
	if counts {
		if err := s.store.ClaimLinkDownload(ctx, l.ID, sess.id, b.ID, s.cfg.Now()); err != nil {
			_ = f.Close()
			return nil, driveError(err)
		}
	}
	return blobResponse{r: requestFrom(ctx), file: f, id: b.ID}, nil
}
