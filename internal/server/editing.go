package server

import (
	"context"
	"time"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
)

// editingTTL is how long a heartbeat holds. Editors send one well within it, so
// a closed tab drops off the list after at most this long.
const editingTTL = 45 * time.Second

// GetEditing lists who else has a node open in an editor.
func (s *Server) GetEditing(ctx context.Context, req oapi.GetEditingRequestObject) (oapi.GetEditingResponseObject, error) {
	a, err := s.authorizeNode(ctx, req.Id, permRead)
	if err != nil {
		return nil, err
	}
	editing, err := s.othersEditing(ctx, a)
	if err != nil {
		return nil, err
	}
	return oapi.GetEditing200JSONResponse(editing), nil
}

// PutEditing is an editor's heartbeat. Only someone who may write the node sends one.
func (s *Server) PutEditing(ctx context.Context, req oapi.PutEditingRequestObject) (oapi.PutEditingResponseObject, error) {
	a, err := s.authorizeNode(ctx, req.Id, permWrite)
	if err != nil {
		return nil, err
	}
	now := s.cfg.Now()
	if err := s.store.MarkEditing(ctx, a.ID, principalFrom(ctx).user.ID, now, now.Add(editingTTL)); err != nil {
		return nil, err
	}
	editing, err := s.othersEditing(ctx, a)
	if err != nil {
		return nil, err
	}
	return oapi.PutEditing200JSONResponse(editing), nil
}

// othersEditing is everyone but the caller with a live heartbeat who still has
// write access: someone whose grant ended or became read-only is not editing.
func (s *Server) othersEditing(ctx context.Context, a authorized) (oapi.Editing, error) {
	me := principalFrom(ctx).user.ID
	editors, err := s.store.Editors(ctx, a.ID, s.cfg.Now())
	if err != nil {
		return oapi.Editing{}, err
	}
	out := oapi.Editing{Editors: []oapi.Editor{}, TtlSeconds: int(editingTTL / time.Second)}
	for _, e := range editors {
		if e.UserID == me {
			continue
		}
		r, _, err := s.effectiveRole(ctx, e.UserID, a.Node)
		if err != nil {
			return oapi.Editing{}, err
		}
		if !r.allows(permWrite) {
			continue
		}
		out.Editors = append(out.Editors, oapi.Editor{UserId: e.UserID, Username: e.Username, Since: e.Since})
	}
	return out, nil
}
