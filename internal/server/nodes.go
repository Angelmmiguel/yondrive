package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"syscall"
	"time"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Bounds on what a client seals for a node. The server cannot read any of it; it
// limits it so that a database stays small and a mistake shows early.
const (
	nameTagLen      = 32
	maxMetadataSize = 64 << 10
	defaultPageSize = 200
	maxPageSize     = 1000
)

// permission is what a request wants to do with a node.
type permission int

const (
	permRead permission = iota
	permWrite
)

// canAccess is the one place that says who may do what with a node. Today that
// is its owner, whatever the permission. Grants belong here, and in the journal's
// reach.
func canAccess(userID string, n store.Node, _ permission) bool {
	return n.OwnerID == userID
}

// authorizeNode loads a node the caller may act on. Someone else's node answers
// exactly as one that does not exist.
func (s *Server) authorizeNode(ctx context.Context, id string, need permission) (store.Node, error) {
	if !blobs.ValidID(id) {
		return store.Node{}, badRequest(codeInvalidID)
	}
	n, err := s.store.NodeByID(ctx, id)
	if err != nil {
		return store.Node{}, driveError(err)
	}
	if !canAccess(principalFrom(ctx).user.ID, n, need) {
		return store.Node{}, fail(http.StatusNotFound, codeNotFound)
	}
	return n, nil
}

// driveError turns what the drive's store and files report into API errors.
func driveError(err error) error {
	for _, e := range []struct {
		err    error
		status int
		code   string
	}{
		{store.ErrNotFound, http.StatusNotFound, codeNotFound},
		{blobs.ErrNotFound, http.StatusNotFound, codeNotFound},
		{store.ErrIDTaken, http.StatusConflict, codeIDTaken},
		{store.ErrNameConflict, http.StatusConflict, codeNameConflict},
		{store.ErrNotFolder, http.StatusConflict, codeNotAFolder},
		{store.ErrNotFile, http.StatusConflict, codeNotAFile},
		{store.ErrMoveCycle, http.StatusConflict, codeMoveCycle},
		{store.ErrTreeTooDeep, http.StatusConflict, codeTreeTooDeep},
		{store.ErrRootImmutable, http.StatusConflict, codeRootImmutable},
		{store.ErrNodeTrashed, http.StatusConflict, codeNodeTrashed},
		{store.ErrParentTrashed, http.StatusConflict, codeParentTrashed},
		{store.ErrMoveAcrossOwners, http.StatusForbidden, codeMoveRefused},
		{store.ErrMoveOutOfShare, http.StatusForbidden, codeMoveRefused},
		{store.ErrKeyGeneration, http.StatusPreconditionFailed, codeKeyGenerationConflict},
		{store.ErrRotateConflict, http.StatusConflict, codeRotateConflict},
		{store.ErrGrantExists, http.StatusConflict, codeGrantExists},
		{store.ErrLinkLimit, http.StatusGone, codeLinkLimitReached},
		{store.ErrNotTrashed, http.StatusConflict, codeNotTrashed},
		{store.ErrVersionConflict, http.StatusPreconditionFailed, codeVersionConflict},
		{store.ErrVersionCurrent, http.StatusConflict, codeVersionCurrent},
		{store.ErrQuotaExceeded, http.StatusRequestEntityTooLarge, codeQuotaExceeded},
		{store.ErrUploadIncomplete, http.StatusConflict, codeUploadIncomplete},
		{store.ErrFrameConflict, http.StatusConflict, codeFrameConflict},
		{store.ErrBlobKept, http.StatusConflict, codeBlobInUse},
		{syscall.ENOSPC, http.StatusInsufficientStorage, codeStorageFull},
	} {
		if errors.Is(err, e.err) {
			return fail(e.status, e.code)
		}
	}
	return err
}

// suite is what every item must carry on this server. A server that has any
// signed-in user is past setup, so its mode is set.
func (s *Server) suite() oapi.Suite {
	if *s.mode.Load() == oapi.ModeNone {
		return oapi.SuiteNone
	}
	return oapi.SuiteXchacha20poly1305V1
}

func (s *Server) checkSuite(got oapi.Suite) error {
	if got != s.suite() {
		return badRequest(codeSuiteMismatch)
	}
	return nil
}

// checkWrappedKey holds a wrapped key to the mode, which is the only thing the
// server can tell about it.
func (s *Server) checkWrappedKey(key []byte) error {
	if s.suite() == oapi.SuiteNone {
		if len(key) != 0 {
			return badRequest(codeKeysNotAllowed)
		}
		return nil
	}
	if len(key) == 0 {
		return badRequest(codeKeysRequired)
	}
	if !validSealed(key) {
		return badRequest(codeInvalidNode)
	}
	return nil
}

func validMetadata(b []byte) bool { return len(b) >= 1 && len(b) <= maxMetadataSize }

func nodeView(n store.Node) oapi.Node {
	out := oapi.Node{
		Id:             n.ID,
		OwnerId:        n.OwnerID,
		Kind:           oapi.NodeKind(n.Kind),
		Suite:          oapi.Suite(n.Suite),
		SealedMetadata: n.SealedMetadata,
		WrappedKey:     n.WrappedKey,
		CreatedAt:      n.CreatedAt,
		UpdatedAt:      n.UpdatedAt,
		ParentId:       optional(n.ParentID),
		CurrentVersion: optional(n.CurrentVersion),
		ThumbBlobId:    optional(n.ThumbBlobID),
		TrashedAt:      optionalTime(n.TrashedAt),
		PurgedAt:       optionalTime(n.PurgedAt),
		RemoveAt:       optionalTime(n.RemoveAt),
	}
	if n.NameTag != nil {
		out.NameTag = &n.NameTag
	}
	return out
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func optionalTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// pageLimit applies the default and the cap to a page size.
func pageLimit(limit *int) (int, error) {
	if limit == nil {
		return defaultPageSize, nil
	}
	if *limit < 1 {
		return 0, badRequest(codeBadRequest)
	}
	return min(*limit, maxPageSize), nil
}

// idCursor checks the cursor of a list paged by id.
func idCursor(cursor *string) (string, error) {
	if cursor == nil {
		return "", nil
	}
	if !blobs.ValidID(*cursor) {
		return "", badRequest(codeInvalidCursor)
	}
	return *cursor, nil
}

// page cuts the extra row a list asked for off the end, and returns the cursor
// that says there may be more.
func page[T any](items []T, limit int, cursor func(T) string) ([]T, *string) {
	if len(items) <= limit {
		return items, nil
	}
	items = items[:limit]
	next := cursor(items[limit-1])
	return items, &next
}

func nodePage(nodes []store.Node, limit int) oapi.NodePage {
	nodes, next := page(nodes, limit, func(n store.Node) string { return n.ID })
	out := oapi.NodePage{Nodes: make([]oapi.Node, 0, len(nodes)), NextCursor: next}
	for _, n := range nodes {
		out.Nodes = append(out.Nodes, nodeView(n))
	}
	return out
}

// GetRootNode returns the caller's root node.
func (s *Server) GetRootNode(ctx context.Context, _ oapi.GetRootNodeRequestObject) (oapi.GetRootNodeResponseObject, error) {
	n, err := s.store.RootNode(ctx, principalFrom(ctx).user.ID)
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.GetRootNode200JSONResponse(nodeView(n)), nil
}

// CreateRootNode makes the caller's root node, or returns the one they have.
func (s *Server) CreateRootNode(ctx context.Context, req oapi.CreateRootNodeRequestObject) (oapi.CreateRootNodeResponseObject, error) {
	in := req.Body
	if !blobs.ValidID(in.Id) {
		return nil, badRequest(codeInvalidID)
	}
	if err := s.checkSuite(in.Suite); err != nil {
		return nil, err
	}
	if err := s.checkWrappedKey(in.WrappedKey); err != nil {
		return nil, err
	}
	var metadata []byte
	if in.SealedMetadata != nil {
		metadata = *in.SealedMetadata
		if len(metadata) > maxMetadataSize {
			return nil, badRequest(codeInvalidNode)
		}
	}
	n, created, err := s.store.CreateRoot(ctx, store.Node{
		ID:             in.Id,
		OwnerID:        principalFrom(ctx).user.ID,
		Suite:          string(in.Suite),
		SealedMetadata: metadata,
		WrappedKey:     in.WrappedKey,
		CreatedAt:      s.cfg.Now(),
	})
	if err != nil {
		return nil, driveError(err)
	}
	if created {
		return oapi.CreateRootNode201JSONResponse(nodeView(n)), nil
	}
	return oapi.CreateRootNode200JSONResponse(nodeView(n)), nil
}

// CreateNode adds a file or folder under a folder the caller may write to.
func (s *Server) CreateNode(ctx context.Context, req oapi.CreateNodeRequestObject) (oapi.CreateNodeResponseObject, error) {
	in := req.Body
	if !blobs.ValidID(in.Id) {
		return nil, badRequest(codeInvalidID)
	}
	if !in.Kind.Valid() || !validMetadata(in.SealedMetadata) || len(in.NameTag) != nameTagLen {
		return nil, badRequest(codeInvalidNode)
	}
	if err := s.checkSuite(in.Suite); err != nil {
		return nil, err
	}
	if err := s.checkWrappedKey(in.WrappedKey); err != nil {
		return nil, err
	}
	parent, err := s.authorizeNode(ctx, in.ParentId, permWrite)
	if err != nil {
		return nil, err
	}
	n, err := s.store.CreateNode(ctx, store.Node{
		ID:             in.Id,
		OwnerID:        parent.OwnerID,
		ParentID:       parent.ID,
		Kind:           string(in.Kind),
		Suite:          string(in.Suite),
		SealedMetadata: in.SealedMetadata,
		WrappedKey:     in.WrappedKey,
		NameTag:        in.NameTag,
		CreatedAt:      s.cfg.Now(),
	}, nil)
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.CreateNode201JSONResponse(nodeView(n)), nil
}

// GetNode returns a node.
func (s *Server) GetNode(ctx context.Context, req oapi.GetNodeRequestObject) (oapi.GetNodeResponseObject, error) {
	n, err := s.authorizeNode(ctx, req.Id, permRead)
	if err != nil {
		return nil, err
	}
	return oapi.GetNode200JSONResponse(nodeView(n)), nil
}

// UpdateNode replaces a node's metadata and, on a rename, its name tag.
func (s *Server) UpdateNode(ctx context.Context, req oapi.UpdateNodeRequestObject) (oapi.UpdateNodeResponseObject, error) {
	in := req.Body
	if err := s.checkSuite(in.Suite); err != nil {
		return nil, err
	}
	var metadata, tag []byte
	if in.SealedMetadata != nil {
		metadata = *in.SealedMetadata
		if !validMetadata(metadata) {
			return nil, badRequest(codeInvalidNode)
		}
	}
	if in.NameTag != nil {
		tag = *in.NameTag
		if len(tag) != nameTagLen {
			return nil, badRequest(codeInvalidNode)
		}
	}
	if _, err := s.authorizeNode(ctx, req.Id, permWrite); err != nil {
		return nil, err
	}
	n, err := s.store.UpdateNode(ctx, req.Id, metadata, tag, store.KeyCheck{}, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.UpdateNode200JSONResponse(nodeView(n)), nil
}

// ListChildren returns a page of a folder's children, by id.
func (s *Server) ListChildren(ctx context.Context, req oapi.ListChildrenRequestObject) (oapi.ListChildrenResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permRead); err != nil {
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
	nodes, err := s.store.ListChildren(ctx, req.Id, after, limit+1)
	if err != nil {
		return nil, err
	}
	return oapi.ListChildren200JSONResponse(nodePage(nodes, limit)), nil
}

// MoveNode puts a node under another folder, with its key wrapped for that folder.
func (s *Server) MoveNode(ctx context.Context, req oapi.MoveNodeRequestObject) (oapi.MoveNodeResponseObject, error) {
	in := req.Body
	if len(in.NameTag) != nameTagLen {
		return nil, badRequest(codeInvalidNode)
	}
	if err := s.checkWrappedKey(in.WrappedKey); err != nil {
		return nil, err
	}
	if _, err := s.authorizeNode(ctx, req.Id, permWrite); err != nil {
		return nil, err
	}
	parent, err := s.authorizeNode(ctx, in.ParentId, permWrite)
	if err != nil {
		return nil, err
	}
	n, err := s.store.MoveNode(ctx, req.Id, parent.ID, in.WrappedKey, in.NameTag, store.MoveGuard{}, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.MoveNode200JSONResponse(nodeView(n)), nil
}

// TrashNode puts a subtree in the trash.
func (s *Server) TrashNode(ctx context.Context, req oapi.TrashNodeRequestObject) (oapi.TrashNodeResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permWrite); err != nil {
		return nil, err
	}
	n, err := s.store.TrashNode(ctx, req.Id, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.TrashNode200JSONResponse(nodeView(n)), nil
}

// RestoreNode takes a node out of the trash, cancelling any purge.
func (s *Server) RestoreNode(ctx context.Context, req oapi.RestoreNodeRequestObject) (oapi.RestoreNodeResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permWrite); err != nil {
		return nil, err
	}
	n, err := s.store.RestoreNode(ctx, req.Id, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.RestoreNode200JSONResponse(nodeView(n)), nil
}

// removalTime says when the bytes of what is marked now will go. It is fixed at
// the time of the mark, so that shortening the grace period later cannot hasten
// anything already marked.
func (s *Server) removalTime(ctx context.Context, now time.Time) (time.Time, error) {
	settings, err := s.store.Settings(ctx)
	if err != nil {
		return time.Time{}, err
	}
	return now.Add(days(settings.PurgeGraceDays)), nil
}

func days(n int) time.Duration { return time.Duration(n) * 24 * time.Hour }

// PurgeNode marks a trashed node for removal after the grace period.
func (s *Server) PurgeNode(ctx context.Context, req oapi.PurgeNodeRequestObject) (oapi.PurgeNodeResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permWrite); err != nil {
		return nil, err
	}
	now := s.cfg.Now()
	removeAt, err := s.removalTime(ctx, now)
	if err != nil {
		return nil, err
	}
	n, err := s.store.PurgeNode(ctx, req.Id, now, removeAt)
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.PurgeNode200JSONResponse(nodeView(n)), nil
}

// ListTrash returns a page of the caller's trash.
func (s *Server) ListTrash(ctx context.Context, req oapi.ListTrashRequestObject) (oapi.ListTrashResponseObject, error) {
	after, err := idCursor(req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	nodes, err := s.store.ListTrash(ctx, principalFrom(ctx).user.ID, after, limit+1)
	if err != nil {
		return nil, err
	}
	return oapi.ListTrash200JSONResponse(nodePage(nodes, limit)), nil
}

// EmptyTrash marks all of the caller's trash for removal after the grace period.
func (s *Server) EmptyTrash(ctx context.Context, _ oapi.EmptyTrashRequestObject) (oapi.EmptyTrashResponseObject, error) {
	now := s.cfg.Now()
	removeAt, err := s.removalTime(ctx, now)
	if err != nil {
		return nil, err
	}
	marked, err := s.store.EmptyTrash(ctx, principalFrom(ctx).user.ID, now, removeAt)
	if err != nil {
		return nil, err
	}
	return oapi.EmptyTrash200JSONResponse{Marked: marked}, nil
}

// ListChanges returns a page of the journal of what the caller can reach.
func (s *Server) ListChanges(ctx context.Context, req oapi.ListChangesRequestObject) (oapi.ListChangesResponseObject, error) {
	var after int64
	if req.Params.Cursor != nil {
		var err error
		if after, err = strconv.ParseInt(*req.Params.Cursor, 10, 64); err != nil || after < 0 {
			return nil, badRequest(codeInvalidCursor)
		}
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	changes, err := s.store.ListChanges(ctx, principalFrom(ctx).user.ID, after, limit)
	if err != nil {
		return nil, err
	}
	out := oapi.ChangePage{Changes: make([]oapi.Change, 0, len(changes))}
	for _, c := range changes {
		out.Changes = append(out.Changes, oapi.Change{Seq: c.Seq, NodeId: c.NodeID, Op: oapi.ChangeOp(c.Op), At: c.At})
		after = c.Seq
	}
	out.NextCursor = strconv.FormatInt(after, 10)
	return oapi.ListChanges200JSONResponse(out), nil
}

// GetMyStorage returns the caller's storage figures.
func (s *Server) GetMyStorage(ctx context.Context, _ oapi.GetMyStorageRequestObject) (oapi.GetMyStorageResponseObject, error) {
	u, err := s.store.UsageOf(ctx, principalFrom(ctx).user.ID)
	if err != nil {
		return nil, err
	}
	return oapi.GetMyStorage200JSONResponse{QuotaBytes: u.QuotaBytes, UsedBytes: u.UsedBytes, ReservedBytes: u.ReservedBytes}, nil
}
