package server

import (
	"context"
	"net/http"
	"strconv"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Bounds on comments. The server cannot read a body or an anchor; it limits
// them so that a file's comments stay a small thing to fetch.
const (
	maxCommentBody   = 16 << 10
	maxCommentAnchor = 4 << 10
	maxComments      = 2000
	// minSealedComment is the overhead of a sealed value with one byte in it.
	minSealedComment = 42
)

const (
	auditCommentCreated  = "comment_created"
	auditCommentEdited   = "comment_edited"
	auditCommentDeleted  = "comment_deleted"
	auditCommentResolved = "comment_resolved"
	auditCommentReopened = "comment_reopened"
	auditCommentAnchored = "comment_anchored"
)

func commentView(c store.Comment) oapi.Comment {
	out := oapi.Comment{
		Id:             c.ID,
		NodeId:         c.NodeID,
		ThreadId:       c.ThreadID,
		AuthorId:       c.AuthorID,
		AuthorUsername: c.AuthorName,
		KeyGeneration:  c.KeyGeneration,
		SealedBody:     c.SealedBody,
		Signature:      c.Signature,
		CreatedAt:      c.CreatedAt,
		EditedAt:       optionalTime(c.EditedAt),
		Resolved:       !c.ResolvedAt.IsZero(),
		ResolvedBy:     optional(c.ResolvedBy),
		ResolvedAt:     optionalTime(c.ResolvedAt),
	}
	if a := c.Anchor; a != nil {
		out.Anchor = &oapi.CommentAnchor{
			KeyGeneration: a.KeyGeneration,
			SealedAnchor:  a.Sealed,
			Signature:     a.Signature,
			SignerId:      a.SignerID,
			UpdatedAt:     a.UpdatedAt,
		}
	}
	return out
}

// checkCommentSealed holds a sealed body or anchor to the mode and to its
// limit. Readable JSON in the no-encryption mode is never empty either.
func (s *Server) checkCommentSealed(b []byte, limit int) error {
	least := minSealedComment
	if s.suite() == oapi.SuiteNone {
		least = 1
	}
	if len(b) < least {
		return badRequest(codeInvalidComment)
	}
	if len(b) > limit {
		return fail(http.StatusRequestEntityTooLarge, codeCommentTooLarge)
	}
	return nil
}

// checkAnchor checks an anchor someone sealed and signed.
func (s *Server) checkAnchor(in *oapi.CommentAnchorInput) error {
	if err := s.checkCommentSealed(in.SealedAnchor, maxCommentAnchor); err != nil {
		return err
	}
	if !s.checkSignature(in.Signature) {
		return badRequest(codeInvalidComment)
	}
	return nil
}

// checkBody checks a body its author sealed and signed.
func (s *Server) checkBody(body, signature []byte) error {
	if err := s.checkCommentSealed(body, maxCommentBody); err != nil {
		return err
	}
	if !s.checkSignature(signature) {
		return badRequest(codeInvalidComment)
	}
	return nil
}

// commentOn loads a comment on a node the caller may act on as need says.
func (s *Server) commentOn(ctx context.Context, nodeID, id string, need permission) (authorized, store.Comment, error) {
	a, err := s.authorizeNode(ctx, nodeID, need)
	if err != nil {
		return authorized{}, store.Comment{}, err
	}
	if !blobs.ValidID(id) {
		return authorized{}, store.Comment{}, badRequest(codeInvalidID)
	}
	c, err := s.store.CommentByID(ctx, a.ID, id)
	if err != nil {
		return authorized{}, store.Comment{}, driveError(err)
	}
	return a, c, nil
}

// ListComments returns a page of a file's comments, oldest first, with the key
// chain down to the oldest generation any of them is sealed under.
func (s *Server) ListComments(ctx context.Context, req oapi.ListCommentsRequestObject) (oapi.ListCommentsResponseObject, error) {
	a, err := s.authorizeNode(ctx, req.Id, permRead)
	if err != nil {
		return nil, err
	}
	var after int64
	if req.Params.Cursor != nil {
		if after, err = strconv.ParseInt(*req.Params.Cursor, 10, 64); err != nil || after < 1 {
			return nil, badRequest(codeInvalidCursor)
		}
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	comments, err := s.store.ListComments(ctx, a.ID, after, limit+1)
	if err != nil {
		return nil, err
	}
	comments, next := page(comments, limit, func(c store.Comment) string { return strconv.FormatInt(c.Seq, 10) })
	out := oapi.CommentPage{Comments: make([]oapi.Comment, 0, len(comments)), NextCursor: next}
	oldest := a.KeyGeneration
	for _, c := range comments {
		out.Comments = append(out.Comments, commentView(c))
		oldest = min(oldest, c.KeyGeneration)
		if c.Anchor != nil {
			oldest = min(oldest, c.Anchor.KeyGeneration)
		}
	}
	chain, err := s.store.KeyChain(ctx, a.ID, oldest)
	if err != nil {
		return nil, err
	}
	out.KeyChain = keyChainView(chain)
	return oapi.ListComments200JSONResponse(out), nil
}

// CreateComment starts a thread, or replies to one.
func (s *Server) CreateComment(ctx context.Context, req oapi.CreateCommentRequestObject) (oapi.CreateCommentResponseObject, error) {
	in := req.Body
	if !blobs.ValidID(in.Id) || (in.ThreadId != nil && !blobs.ValidID(*in.ThreadId)) {
		return nil, badRequest(codeInvalidID)
	}
	if err := s.checkBody(in.SealedBody, in.Signature); err != nil {
		return nil, err
	}
	actor := principalFrom(ctx).user.ID
	c := store.Comment{
		ID:            in.Id,
		ThreadID:      in.Id,
		AuthorID:      actor,
		KeyGeneration: in.KeyGeneration,
		SealedBody:    in.SealedBody,
		Signature:     in.Signature,
		CreatedAt:     s.cfg.Now(),
	}
	if in.ThreadId != nil {
		c.ThreadID = *in.ThreadId
	}
	if in.Anchor != nil {
		if c.ThreadID != c.ID {
			return nil, badRequest(codeInvalidComment)
		}
		if err := s.checkAnchor(in.Anchor); err != nil {
			return nil, err
		}
		c.Anchor = &store.CommentAnchor{KeyGeneration: in.Anchor.KeyGeneration, Sealed: in.Anchor.SealedAnchor, Signature: in.Anchor.Signature}
	}
	a, err := s.authorizeNode(ctx, req.Id, permComment)
	if err != nil {
		return nil, err
	}
	c.NodeID = a.ID
	out, err := s.store.CreateComment(ctx, c, maxComments)
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditCommentCreated, actor, out.ID)
	return oapi.CreateComment201JSONResponse(commentView(out)), nil
}

// UpdateComment replaces the body of the caller's own comment.
func (s *Server) UpdateComment(ctx context.Context, req oapi.UpdateCommentRequestObject) (oapi.UpdateCommentResponseObject, error) {
	in := req.Body
	if err := s.checkBody(in.SealedBody, in.Signature); err != nil {
		return nil, err
	}
	a, c, err := s.commentOn(ctx, req.Id, req.CommentId, permComment)
	if err != nil {
		return nil, err
	}
	actor := principalFrom(ctx).user.ID
	if c.AuthorID != actor {
		return nil, fail(http.StatusForbidden, codeForbidden)
	}
	out, err := s.store.UpdateCommentBody(ctx, a.ID, c.ID, in.KeyGeneration, in.SealedBody, in.Signature, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditCommentEdited, actor, out.ID)
	return oapi.UpdateComment200JSONResponse(commentView(out)), nil
}

// DeleteComment removes a comment: its author's, while they may comment, or the
// owner's, of anyone's.
func (s *Server) DeleteComment(ctx context.Context, req oapi.DeleteCommentRequestObject) (oapi.DeleteCommentResponseObject, error) {
	a, c, err := s.commentOn(ctx, req.Id, req.CommentId, permRead)
	if err != nil {
		return nil, err
	}
	actor := principalFrom(ctx).user.ID
	owner := a.role.allows(permOwn)
	if c.AuthorID != actor || !a.role.allows(permComment) {
		if !owner {
			return nil, fail(http.StatusForbidden, codeForbidden)
		}
	}
	// The owner may delete a whole thread; its author only one nobody else has answered.
	sparing := actor
	if owner {
		sparing = ""
	}
	if err := s.store.DeleteComment(ctx, a.ID, c.ID, sparing, s.cfg.Now()); err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditCommentDeleted, actor, c.ID)
	return oapi.DeleteComment204Response{}, nil
}

// UpdateCommentAnchor moves a thread's anchor, sealed and signed by an editor.
func (s *Server) UpdateCommentAnchor(ctx context.Context, req oapi.UpdateCommentAnchorRequestObject) (oapi.UpdateCommentAnchorResponseObject, error) {
	if err := s.checkAnchor(req.Body); err != nil {
		return nil, err
	}
	a, c, err := s.commentOn(ctx, req.Id, req.CommentId, permWrite)
	if err != nil {
		return nil, err
	}
	actor := principalFrom(ctx).user.ID
	out, err := s.store.SetCommentAnchor(ctx, a.ID, c.ID, store.CommentAnchor{
		KeyGeneration: req.Body.KeyGeneration,
		Sealed:        req.Body.SealedAnchor,
		Signature:     req.Body.Signature,
		SignerID:      actor,
	}, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditCommentAnchored, actor, out.ID)
	return oapi.UpdateCommentAnchor200JSONResponse(commentView(out)), nil
}

// ResolveComment resolves a thread, or reopens it.
func (s *Server) ResolveComment(ctx context.Context, req oapi.ResolveCommentRequestObject) (oapi.ResolveCommentResponseObject, error) {
	a, c, err := s.commentOn(ctx, req.Id, req.CommentId, permWrite)
	if err != nil {
		return nil, err
	}
	actor := principalFrom(ctx).user.ID
	out, err := s.store.ResolveComment(ctx, a.ID, c.ID, actor, req.Body.Resolved, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	action := auditCommentReopened
	if req.Body.Resolved {
		action = auditCommentResolved
	}
	s.audit(ctx, action, actor, out.ID)
	return oapi.ResolveComment200JSONResponse(commentView(out)), nil
}

// commentNotifications lists the files with comments the user has not seen,
// leaving out those they cannot read now.
func (s *Server) commentNotifications(ctx context.Context, user string) ([]oapi.CommentNotification, error) {
	notices, err := s.store.ListCommentNotices(ctx, user, notificationScan)
	if err != nil {
		return nil, err
	}
	out := make([]oapi.CommentNotification, 0, min(len(notices), maxNotifications))
	for _, n := range notices {
		if len(out) == maxNotifications {
			break
		}
		node, err := s.store.NodeByID(ctx, n.NodeID)
		if err != nil {
			return nil, err
		}
		self, _, err := s.effectiveRole(ctx, user, node)
		if err != nil {
			return nil, err
		}
		if self == roleNone {
			continue
		}
		if hidden, err := s.store.NodeInTrash(ctx, n.NodeID); err != nil || hidden {
			if err != nil {
				return nil, err
			}
			continue
		}
		out = append(out, oapi.CommentNotification{
			NodeId: n.NodeID, CommentId: n.CommentID, AuthorId: n.AuthorID, Count: n.Count, CreatedAt: n.CreatedAt,
		})
	}
	return out, nil
}
