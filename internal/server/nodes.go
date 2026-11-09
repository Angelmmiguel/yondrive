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
	// permComment writes comments, and nothing else.
	permComment
	permWrite
	permOwn
)

// role is what a user may do with a node, weakest first.
type role int

const (
	roleNone role = iota
	roleViewer
	roleCommenter
	roleEditor
	roleOwner
)

func (r role) allows(need permission) bool {
	switch need {
	case permRead:
		return r >= roleViewer
	case permComment:
		return r >= roleCommenter
	case permWrite:
		return r >= roleEditor
	default:
		return r == roleOwner
	}
}

// grantRole reads the role of a grant.
func grantRole(g string) role {
	switch g {
	case store.RoleEditor:
		return roleEditor
	case store.RoleCommenter:
		return roleCommenter
	case store.RoleViewer:
		return roleViewer
	}
	return roleNone
}

func (r role) view() *oapi.NodeRole {
	var out oapi.NodeRole
	switch r {
	case roleOwner:
		out = oapi.NodeRoleOwner
	case roleEditor:
		out = oapi.NodeRoleEditor
	case roleCommenter:
		out = oapi.NodeRoleCommenter
	case roleViewer:
		out = oapi.NodeRoleViewer
	default:
		return nil
	}
	return &out
}

// effectiveRole is the one place that says who may do what with a node. An owner
// may do anything. Anyone else has the strongest role a grant gives them on the
// node or on a folder above it, and none at all while any of those is in the
// trash. It also returns the role over the parent, which is what a rename, a move
// or trashing changes. The walk is bounded by the depth a tree can reach.
func (s *Server) effectiveRole(ctx context.Context, userID string, n store.Node) (self, parent role, err error) {
	if n.OwnerID == userID {
		return roleOwner, roleOwner, nil
	}
	chain, err := s.store.LineageRoles(ctx, userID, n.ID)
	if err != nil {
		return roleNone, roleNone, err
	}
	for _, e := range chain {
		if e.Trashed {
			return roleNone, roleNone, nil
		}
		r := grantRole(e.Role)
		self = max(self, r)
		if e.Depth > 0 {
			parent = max(parent, r)
		}
	}
	return self, parent, nil
}

// authorized is a node and what the caller may do with it.
type authorized struct {
	store.Node
	role, parentRole role
}

// view shows a node as of now to the caller authorized for it.
func (a authorized) view(n store.Node) oapi.Node { return nodeView(n, a.role, a.parentRole) }

// authorizeNode loads a node the caller may act on. Someone with no role over a
// node gets the same answer as if it did not exist. Someone who can see it but
// not do this is told so.
func (s *Server) authorizeNode(ctx context.Context, id string, need permission) (authorized, error) {
	if !blobs.ValidID(id) {
		return authorized{}, badRequest(codeInvalidID)
	}
	n, err := s.store.NodeByID(ctx, id)
	if err != nil {
		return authorized{}, driveError(err)
	}
	self, parent, err := s.effectiveRole(ctx, principalFrom(ctx).user.ID, n)
	if err != nil {
		return authorized{}, err
	}
	if self == roleNone {
		return authorized{}, fail(http.StatusNotFound, codeNotFound)
	}
	if !self.allows(need) {
		return authorized{}, fail(http.StatusForbidden, codeForbidden)
	}
	return authorized{Node: n, role: self, parentRole: parent}, nil
}

// requireParentWrite refuses what changes the folder a node lives in to someone
// who cannot write to that folder: an editor on the node of their own grant.
func (a authorized) requireParentWrite() error {
	if !a.parentRole.allows(permWrite) {
		return fail(http.StatusForbidden, codeForbidden)
	}
	return nil
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
		{store.ErrCommentLimit, http.StatusConflict, codeCommentLimitReached},
		{store.ErrNotThread, http.StatusBadRequest, codeInvalidComment},
		{store.ErrHasReplies, http.StatusConflict, codeCommentHasReplies},
		{store.ErrUploadIncomplete, http.StatusConflict, codeUploadIncomplete},
		{store.ErrTooManyUploads, http.StatusConflict, codeTooManyUploads},
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

// nodeView shows a node to someone with these roles over it and its parent. What
// belongs to the folder above a shared node is not theirs to see.
func nodeView(n store.Node, self, parent role) oapi.Node {
	if parent == roleNone {
		n.ParentID, n.NameTag, n.WrappedKey = "", nil, []byte{}
	}
	generation := n.KeyGeneration
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
		KeyGeneration:  &generation,
		CommentSeq:     &n.CommentSeq,
		Role:           self.view(),
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

func nodePage(nodes []store.Node, limit int, view func(store.Node) oapi.Node) oapi.NodePage {
	nodes, next := page(nodes, limit, func(n store.Node) string { return n.ID })
	out := oapi.NodePage{Nodes: make([]oapi.Node, 0, len(nodes)), NextCursor: next}
	for _, n := range nodes {
		out.Nodes = append(out.Nodes, view(n))
	}
	return out
}

func ownerView(n store.Node) oapi.Node { return nodeView(n, roleOwner, roleOwner) }

// GetRootNode returns the caller's root node.
func (s *Server) GetRootNode(ctx context.Context, _ oapi.GetRootNodeRequestObject) (oapi.GetRootNodeResponseObject, error) {
	n, err := s.store.RootNode(ctx, principalFrom(ctx).user.ID)
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.GetRootNode200JSONResponse(ownerView(n)), nil
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
		return oapi.CreateRootNode201JSONResponse(ownerView(n)), nil
	}
	return oapi.CreateRootNode200JSONResponse(ownerView(n)), nil
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
	}, in.ParentKeyGeneration)
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.CreateNode201JSONResponse(nodeView(n, parent.role, parent.role)), nil
}

// GetNode returns a node.
func (s *Server) GetNode(ctx context.Context, req oapi.GetNodeRequestObject) (oapi.GetNodeResponseObject, error) {
	a, err := s.authorizeNode(ctx, req.Id, permRead)
	if err != nil {
		return nil, err
	}
	return oapi.GetNode200JSONResponse(a.view(a.Node)), nil
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
	a, err := s.authorizeNode(ctx, req.Id, permWrite)
	if err != nil {
		return nil, err
	}
	if tag != nil {
		if err := a.requireParentWrite(); err != nil {
			return nil, err
		}
	}
	n, err := s.store.UpdateNode(ctx, req.Id, metadata, tag, store.KeyCheck{Node: in.KeyGeneration, Parent: in.ParentKeyGeneration}, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.UpdateNode200JSONResponse(a.view(n)), nil
}

// ListChildren returns a page of a folder's children, by id.
func (s *Server) ListChildren(ctx context.Context, req oapi.ListChildrenRequestObject) (oapi.ListChildrenResponseObject, error) {
	a, err := s.authorizeNode(ctx, req.Id, permRead)
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
	nodes, err := s.store.ListChildren(ctx, req.Id, after, limit+1)
	if err != nil {
		return nil, err
	}
	own, err := s.grantsOnPage(ctx, a, nodes)
	if err != nil {
		return nil, err
	}
	return oapi.ListChildren200JSONResponse(nodePage(nodes, limit, func(n store.Node) oapi.Node {
		return nodeView(n, max(a.role, grantRole(own[n.ID])), a.role)
	})), nil
}

// grantsOnPage returns the grants the caller holds on some of a folder's
// children, which can give more than the folder does.
func (s *Server) grantsOnPage(ctx context.Context, a authorized, nodes []store.Node) (map[string]string, error) {
	if a.role == roleOwner {
		return nil, nil
	}
	ids := make([]string, 0, len(nodes))
	for _, n := range nodes {
		ids = append(ids, n.ID)
	}
	return s.store.GrantRolesOn(ctx, principalFrom(ctx).user.ID, ids)
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
	a, err := s.authorizeNode(ctx, req.Id, permWrite)
	if err != nil {
		return nil, err
	}
	parent, err := s.authorizeNode(ctx, in.ParentId, permWrite)
	if err != nil {
		return nil, err
	}
	guard := store.MoveGuard{ParentGeneration: in.ParentKeyGeneration}
	if a.role != roleOwner {
		guard.EditorID = principalFrom(ctx).user.ID
	}
	n, err := s.store.MoveNode(ctx, req.Id, parent.ID, in.WrappedKey, in.NameTag, guard, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.MoveNode200JSONResponse(nodeView(n, a.role, parent.role)), nil
}

// TrashNode puts a subtree in the trash.
func (s *Server) TrashNode(ctx context.Context, req oapi.TrashNodeRequestObject) (oapi.TrashNodeResponseObject, error) {
	a, err := s.authorizeNode(ctx, req.Id, permWrite)
	if err != nil {
		return nil, err
	}
	if err := a.requireParentWrite(); err != nil {
		return nil, err
	}
	n, err := s.store.TrashNode(ctx, req.Id, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.TrashNode200JSONResponse(a.view(n)), nil
}

// RestoreNode takes a node out of the trash, cancelling any purge.
func (s *Server) RestoreNode(ctx context.Context, req oapi.RestoreNodeRequestObject) (oapi.RestoreNodeResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permOwn); err != nil {
		return nil, err
	}
	n, err := s.store.RestoreNode(ctx, req.Id, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.RestoreNode200JSONResponse(ownerView(n)), nil
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
	if _, err := s.authorizeNode(ctx, req.Id, permOwn); err != nil {
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
	return oapi.PurgeNode200JSONResponse(ownerView(n)), nil
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
	return oapi.ListTrash200JSONResponse(nodePage(nodes, limit, ownerView)), nil
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
	userID := principalFrom(ctx).user.ID
	changes, err := s.store.ListChanges(ctx, userID, after, limit)
	if err != nil {
		return nil, err
	}
	// After the page: a trim in between must show here, not as a silent gap.
	floor, err := s.store.JournalFloor(ctx, userID)
	if err != nil {
		return nil, err
	}
	if req.Params.Cursor != nil && after < floor {
		return nil, fail(http.StatusGone, codeCursorExpired)
	}
	out := oapi.ChangePage{Changes: make([]oapi.Change, 0, len(changes))}
	for _, c := range changes {
		out.Changes = append(out.Changes, oapi.Change{Seq: c.Seq, NodeId: c.NodeID, Op: oapi.ChangeOp(c.Op), At: c.At})
		after = c.Seq
	}
	out.NextCursor = strconv.FormatInt(max(after, floor), 10)
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
