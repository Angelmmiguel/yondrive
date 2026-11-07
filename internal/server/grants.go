package server

import (
	"context"
	"errors"
	"net/http"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Sizes of what a client seals for sharing (CRYPTO.md, section 8).
const (
	sealedKeyLen = 73
	grantLen     = 105
	// maxNotifications is how long the list of unread grants gets.
	maxNotifications = 50
	// notificationScan is how many unread grants are looked through to fill it,
	// as those in the owner's trash do not show.
	notificationScan = 200
	maxMarkRead      = 1000
)

const (
	auditGrantCreated     = "grant_created"
	auditGrantRoleChanged = "grant_role_changed"
	auditGrantRevoked     = "grant_revoked"
	auditGrantLeft        = "grant_left"
	auditNodeRotated      = "node_rotated"
)

func grantView(g store.Grant) oapi.Grant {
	return oapi.Grant{
		Id:              g.ID,
		NodeId:          g.NodeID,
		GranteeId:       g.GranteeID,
		GranteeUsername: g.GranteeName,
		GranterId:       g.GranterID,
		GranterUsername: g.GranterName,
		Role:            oapi.GrantRole(g.Role),
		KeyGeneration:   g.KeyGeneration,
		SealedKey:       g.SealedKey,
		Signature:       g.Signature,
		CreatedAt:       g.CreatedAt,
	}
}

// checkSignature holds a signature to the mode.
func (s *Server) checkSignature(signature []byte) bool {
	if s.suite() == oapi.SuiteNone {
		return len(signature) == 0
	}
	return len(signature) == signatureLen
}

// checkSealed holds a sealed value to its exact size, or to nothing in the
// no-encryption mode.
func (s *Server) checkSealed(b []byte, size int) bool {
	if s.suite() == oapi.SuiteNone {
		return len(b) == 0
	}
	return len(b) == size
}

// CreateGrant shares a node with another user.
func (s *Server) CreateGrant(ctx context.Context, req oapi.CreateGrantRequestObject) (oapi.CreateGrantResponseObject, error) {
	in := req.Body
	if !blobs.ValidID(in.GranteeId) {
		return nil, badRequest(codeInvalidID)
	}
	if !in.Role.Valid() || !s.checkSealed(in.SealedKey, grantLen) || !s.checkSignature(in.Signature) {
		return nil, badRequest(codeInvalidGrant)
	}
	a, err := s.authorizeNode(ctx, in.NodeId, permOwn)
	if err != nil {
		return nil, err
	}
	if in.GranteeId == a.OwnerID {
		return nil, badRequest(codeInvalidGrant)
	}
	grantee, err := s.store.UserByID(ctx, in.GranteeId)
	if errors.Is(err, store.ErrNotFound) || (err == nil && grantee.Disabled) {
		return nil, fail(http.StatusNotFound, codeNotFound)
	}
	if err != nil {
		return nil, err
	}
	actor := principalFrom(ctx).user.ID
	g, err := s.store.CreateGrant(ctx, store.Grant{
		ID:            store.NewID(),
		NodeID:        a.ID,
		GranteeID:     grantee.ID,
		GranterID:     actor,
		Role:          string(in.Role),
		KeyGeneration: in.KeyGeneration,
		SealedKey:     in.SealedKey,
		Signature:     in.Signature,
		CreatedAt:     s.cfg.Now(),
	})
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditGrantCreated, actor, g.ID)
	return oapi.CreateGrant201JSONResponse(grantView(g)), nil
}

// grantByID loads a grant, whose id has been checked.
func (s *Server) grantByID(ctx context.Context, id string) (store.Grant, error) {
	if !blobs.ValidID(id) {
		return store.Grant{}, badRequest(codeInvalidID)
	}
	g, err := s.store.GrantByID(ctx, id)
	if err != nil {
		return store.Grant{}, driveError(err)
	}
	return g, nil
}

// UpdateGrant changes the role of a grant.
func (s *Server) UpdateGrant(ctx context.Context, req oapi.UpdateGrantRequestObject) (oapi.UpdateGrantResponseObject, error) {
	in := req.Body
	if !in.Role.Valid() || !s.checkSignature(in.Signature) {
		return nil, badRequest(codeInvalidGrant)
	}
	g, err := s.grantByID(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if _, err := s.authorizeNode(ctx, g.NodeID, permOwn); err != nil {
		return nil, err
	}
	g, err = s.store.UpdateGrantRole(ctx, g.ID, string(in.Role), in.Signature, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditGrantRoleChanged, principalFrom(ctx).user.ID, g.ID)
	s.drainRemovalsLogged(ctx)
	return oapi.UpdateGrant200JSONResponse(grantView(g)), nil
}

// DeleteGrant revokes a grant, which its owner may do and its holder may do for
// themselves, even on a node they cannot see at the moment.
func (s *Server) DeleteGrant(ctx context.Context, req oapi.DeleteGrantRequestObject) (oapi.DeleteGrantResponseObject, error) {
	g, err := s.grantByID(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	actor := principalFrom(ctx).user.ID
	action := auditGrantLeft
	if g.GranteeID != actor {
		if _, err := s.authorizeNode(ctx, g.NodeID, permOwn); err != nil {
			return nil, err
		}
		action = auditGrantRevoked
	}
	if err := s.store.DeleteGrant(ctx, g.ID); err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, action, actor, g.ID)
	s.drainRemovalsLogged(ctx)
	return oapi.DeleteGrant204Response{}, nil
}

// ListGrantsMade returns a page of the grants the caller has made.
func (s *Server) ListGrantsMade(ctx context.Context, req oapi.ListGrantsMadeRequestObject) (oapi.ListGrantsMadeResponseObject, error) {
	after, err := idCursor(req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	grants, err := s.store.ListGrantsByGranter(ctx, principalFrom(ctx).user.ID, after, limit+1)
	if err != nil {
		return nil, err
	}
	grants, next := page(grants, limit, func(g store.Grant) string { return g.ID })
	out := oapi.GrantPage{Items: make([]oapi.GrantedNode, 0, len(grants)), NextCursor: next}
	for _, g := range grants {
		n, err := s.store.NodeByID(ctx, g.NodeID)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, oapi.GrantedNode{Grant: grantView(g), Node: ownerView(n)})
	}
	return oapi.ListGrantsMade200JSONResponse(out), nil
}

// ListSharedWithMe returns a page of the grants the caller holds, leaving out what
// they cannot reach at the moment.
func (s *Server) ListSharedWithMe(ctx context.Context, req oapi.ListSharedWithMeRequestObject) (oapi.ListSharedWithMeResponseObject, error) {
	after, err := idCursor(req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	user := principalFrom(ctx).user.ID
	grants, err := s.store.ListGrantsForGrantee(ctx, user, after, limit+1)
	if err != nil {
		return nil, err
	}
	grants, next := page(grants, limit, func(g store.Grant) string { return g.ID })
	out := oapi.GrantPage{Items: make([]oapi.GrantedNode, 0, len(grants)), NextCursor: next}
	for _, g := range grants {
		n, err := s.store.NodeByID(ctx, g.NodeID)
		if err != nil {
			return nil, err
		}
		self, parent, err := s.effectiveRole(ctx, user, n)
		if err != nil {
			return nil, err
		}
		if self == roleNone {
			continue
		}
		out.Items = append(out.Items, oapi.GrantedNode{Grant: grantView(g), Node: nodeView(n, self, parent)})
	}
	return oapi.ListSharedWithMe200JSONResponse(out), nil
}

// ListNodeAccess returns who reaches a node through a grant. The owner sees every
// grant, with the sealed keys and signatures it has to replace. Anyone else sees
// their own grants and the editors', which a client needs to check who may have
// signed a version it reads, and not who else may only read.
func (s *Server) ListNodeAccess(ctx context.Context, req oapi.ListNodeAccessRequestObject) (oapi.ListNodeAccessResponseObject, error) {
	a, err := s.authorizeNode(ctx, req.Id, permRead)
	if err != nil {
		return nil, err
	}
	grants, err := s.store.ListLineageGrants(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	user := principalFrom(ctx).user.ID
	out := oapi.NodeAccessList{Access: make([]oapi.NodeAccess, 0, len(grants))}
	for _, g := range grants {
		if a.role != roleOwner && g.GranteeID != user && g.Role != store.RoleEditor {
			continue
		}
		entry := oapi.NodeAccess{UserId: g.GranteeID, Username: g.GranteeName, Role: oapi.GrantRole(g.Role), Inherited: g.Depth > 0}
		if g.GranteeID == user {
			entry.GrantId = &g.ID
		}
		if a.role == roleOwner {
			entry.GrantId, entry.NodeId = &g.ID, &g.NodeID
			entry.KeyGeneration, entry.SealedKey, entry.Signature = &g.KeyGeneration, &g.SealedKey, &g.Signature
		}
		out.Access = append(out.Access, entry)
	}
	return oapi.ListNodeAccess200JSONResponse(out), nil
}

// LookupUser finds a user by exact username, for someone about to share with them.
func (s *Server) LookupUser(ctx context.Context, req oapi.LookupUserRequestObject) (oapi.LookupUserResponseObject, error) {
	user := principalFrom(ctx).user.ID
	address := s.rateLimitKey(requestFrom(ctx))
	if !s.lookupLimiter.Allow("user/"+user) || !s.lookupLimiter.Allow("address/"+address) {
		return nil, fail(http.StatusTooManyRequests, codeRateLimited)
	}
	username := normalizeUsername(req.Params.Username)
	if !usernamePattern.MatchString(username) {
		return nil, fail(http.StatusNotFound, codeNotFound)
	}
	u, err := s.store.UserByUsername(ctx, username)
	if errors.Is(err, store.ErrNotFound) || (err == nil && u.Disabled) {
		return nil, fail(http.StatusNotFound, codeNotFound)
	}
	if err != nil {
		return nil, err
	}
	out := oapi.UserLookup{Id: u.ID, Username: u.Username}
	if u.PublicKeyX25519 != nil {
		out.PublicKeys = &oapi.PublicKeys{X25519: u.PublicKeyX25519, Ed25519: u.PublicKeyEd25519}
	}
	return oapi.LookupUser200JSONResponse(out), nil
}

// ListNotifications returns what has been shared with the caller and not marked
// as read: ids only, as names are sealed.
func (s *Server) ListNotifications(ctx context.Context, _ oapi.ListNotificationsRequestObject) (oapi.ListNotificationsResponseObject, error) {
	grants, err := s.store.ListUnreadGrants(ctx, principalFrom(ctx).user.ID, notificationScan)
	if err != nil {
		return nil, err
	}
	out := oapi.NotificationList{Notifications: make([]oapi.Notification, 0, min(len(grants), maxNotifications))}
	for _, g := range grants {
		hidden, err := s.store.NodeInTrash(ctx, g.NodeID)
		if err != nil {
			return nil, err
		}
		if hidden {
			continue
		}
		if len(out.Notifications) == maxNotifications {
			out.HasMore = true
			break
		}
		out.Notifications = append(out.Notifications, oapi.Notification{
			GrantId: g.ID, NodeId: g.NodeID, GranterId: g.GranterID, CreatedAt: g.CreatedAt,
		})
	}
	return oapi.ListNotifications200JSONResponse(out), nil
}

// MarkNotificationsRead marks the caller's notifications as read.
func (s *Server) MarkNotificationsRead(ctx context.Context, req oapi.MarkNotificationsReadRequestObject) (oapi.MarkNotificationsReadResponseObject, error) {
	var ids []string
	if req.Body.GrantIds != nil {
		ids = *req.Body.GrantIds
		if ids == nil {
			ids = []string{}
		}
		if len(ids) > maxMarkRead {
			return nil, badRequest(codeBadRequest)
		}
		for _, id := range ids {
			if !blobs.ValidID(id) {
				return nil, badRequest(codeInvalidID)
			}
		}
	}
	if err := s.store.MarkGrantsRead(ctx, principalFrom(ctx).user.ID, ids, s.cfg.Now()); err != nil {
		return nil, err
	}
	return oapi.MarkNotificationsRead204Response{}, nil
}

// RotateNode replaces a node's key: the client sealed it all, and this only checks
// sizes and swaps it in one transaction.
func (s *Server) RotateNode(ctx context.Context, req oapi.RotateNodeRequestObject) (oapi.RotateNodeResponseObject, error) {
	ctx = context.WithoutCancel(ctx)
	in := req.Body
	if !validMetadata(in.SealedMetadata) || !s.checkSealed(in.PreviousKey, sealedKeyLen) || !s.validWrap(in.WrappedKey) {
		return nil, badRequest(codeInvalidRotation)
	}
	rotation := store.Rotation{
		KeyGeneration:       in.KeyGeneration,
		ParentKeyGeneration: in.ParentKeyGeneration,
		WrappedKey:          in.WrappedKey,
		PreviousKey:         in.PreviousKey,
		SealedMetadata:      in.SealedMetadata,
		Children:            make([]store.RotatedChild, 0, len(in.Children)),
		Grants:              make([]store.RotatedGrant, 0, len(in.Grants)),
	}
	for _, c := range in.Children {
		if !blobs.ValidID(c.Id) {
			return nil, badRequest(codeInvalidID)
		}
		if len(c.NameTag) != nameTagLen || !s.validWrap(c.WrappedKey) {
			return nil, badRequest(codeInvalidRotation)
		}
		rotation.Children = append(rotation.Children, store.RotatedChild{ID: c.Id, WrappedKey: c.WrappedKey, NameTag: c.NameTag})
	}
	for _, g := range in.Grants {
		if !blobs.ValidID(g.GranteeId) {
			return nil, badRequest(codeInvalidID)
		}
		if !s.checkSealed(g.SealedKey, grantLen) || !s.checkSignature(g.Signature) {
			return nil, badRequest(codeInvalidRotation)
		}
		rotation.Grants = append(rotation.Grants, store.RotatedGrant{GranteeID: g.GranteeId, SealedKey: g.SealedKey, Signature: g.Signature})
	}
	if in.Links != nil {
		for _, l := range *in.Links {
			if !blobs.ValidID(l.Id) {
				return nil, badRequest(codeInvalidID)
			}
			if !s.checkSealed(l.SealedKey, sealedKeyLen) {
				return nil, badRequest(codeInvalidRotation)
			}
			rotation.Links = append(rotation.Links, store.RotatedLink{ID: l.Id, SealedKey: l.SealedKey})
		}
	}
	for _, drop := range []struct {
		ids  *[]string
		into *[]string
	}{{in.DropGrants, &rotation.DropGrants}, {in.DropLinks, &rotation.DropLinks}} {
		if drop.ids == nil {
			continue
		}
		for _, id := range *drop.ids {
			if !blobs.ValidID(id) {
				return nil, badRequest(codeInvalidID)
			}
		}
		*drop.into = *drop.ids
	}
	if _, err := s.authorizeNode(ctx, req.Id, permOwn); err != nil {
		return nil, err
	}
	n, err := s.store.RotateNode(ctx, req.Id, rotation, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	s.audit(ctx, auditNodeRotated, principalFrom(ctx).user.ID, n.ID)
	s.drainRemovalsLogged(ctx)
	return oapi.RotateNode200JSONResponse(ownerView(n)), nil
}

// validWrap checks a node key wrapped under a parent against the mode.
func (s *Server) validWrap(key []byte) bool {
	if s.suite() == oapi.SuiteNone {
		return len(key) == 0
	}
	return validSealed(key)
}
