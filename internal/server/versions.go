package server

import (
	"context"
	"strconv"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

func versionSummaryView(v store.Version) oapi.VersionSummary {
	generation := v.KeyGeneration
	return oapi.VersionSummary{
		KeyGeneration:    &generation,
		Id:               v.ID,
		NodeId:           v.NodeID,
		BlobId:           v.BlobID,
		Suite:            oapi.Suite(v.Suite),
		AuthorId:         v.AuthorID,
		ContentVersionId: v.ContentVersionID,
		ContentAuthorId:  v.ContentAuthorID,
		StoredSize:       v.StoredSize,
		FrameCount:       v.FrameCount,
		FrameSize:        v.FrameSize,
		CreatedAt:        v.CreatedAt,
		DeletedAt:        optionalTime(v.DeletedAt),
		RemoveAt:         optionalTime(v.RemoveAt),
	}
}

func versionView(v store.Version) oapi.Version {
	generation := v.KeyGeneration
	return oapi.Version{
		KeyGeneration:    &generation,
		KeyChain:         keyChainView(v.KeyChain),
		Id:               v.ID,
		NodeId:           v.NodeID,
		BlobId:           v.BlobID,
		Suite:            oapi.Suite(v.Suite),
		AuthorId:         v.AuthorID,
		ContentVersionId: v.ContentVersionID,
		ContentAuthorId:  v.ContentAuthorID,
		StoredSize:       v.StoredSize,
		FrameCount:       v.FrameCount,
		FrameSize:        v.FrameSize,
		FrameHashes:      v.FrameHashes,
		Signature:        v.Signature,
		Manifest:         v.Manifest,
		CreatedAt:        v.CreatedAt,
		DeletedAt:        optionalTime(v.DeletedAt),
		RemoveAt:         optionalTime(v.RemoveAt),
	}
}

func keyChainView(chain []store.KeyLink) *[]oapi.KeyLink {
	if len(chain) == 0 {
		return nil
	}
	out := make([]oapi.KeyLink, 0, len(chain))
	for _, l := range chain {
		out = append(out, oapi.KeyLink{Generation: l.Generation, SealedKey: l.SealedKey})
	}
	return &out
}

// ListVersions returns a page of a file's versions, newest first.
func (s *Server) ListVersions(ctx context.Context, req oapi.ListVersionsRequestObject) (oapi.ListVersionsResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permRead); err != nil {
		return nil, err
	}
	var before int64
	if req.Params.Cursor != nil {
		var err error
		if before, err = strconv.ParseInt(*req.Params.Cursor, 10, 64); err != nil || before < 1 {
			return nil, badRequest(codeInvalidCursor)
		}
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	versions, err := s.store.ListVersions(ctx, req.Id, before, limit+1)
	if err != nil {
		return nil, err
	}
	versions, next := page(versions, limit, func(v store.Version) string { return strconv.FormatInt(v.Seq, 10) })
	out := oapi.VersionPage{Versions: make([]oapi.VersionSummary, 0, len(versions)), NextCursor: next}
	for _, v := range versions {
		out.Versions = append(out.Versions, versionSummaryView(v))
	}
	return oapi.ListVersions200JSONResponse(out), nil
}

// GetVersion returns a version, with its frame hashes, signature and manifest.
func (s *Server) GetVersion(ctx context.Context, req oapi.GetVersionRequestObject) (oapi.GetVersionResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permRead); err != nil {
		return nil, err
	}
	if !blobs.ValidID(req.VersionId) {
		return nil, badRequest(codeInvalidID)
	}
	v, err := s.store.VersionByID(ctx, req.Id, req.VersionId)
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.GetVersion200JSONResponse(versionView(v)), nil
}

// RestoreVersion makes an older version current again, as a new version over the
// same blob.
func (s *Server) RestoreVersion(ctx context.Context, req oapi.RestoreVersionRequestObject) (oapi.RestoreVersionResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permWrite); err != nil {
		return nil, err
	}
	if !blobs.ValidID(req.VersionId) || !blobs.ValidID(req.Body.VersionId) {
		return nil, badRequest(codeInvalidID)
	}
	v, err := s.store.RestoreVersion(ctx, req.Id, req.VersionId, req.Body.VersionId,
		principalFrom(ctx).user.ID, req.Body.ExpectedVersion, s.cfg.Now())
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.RestoreVersion201JSONResponse(versionView(v)), nil
}

// DeleteVersion marks a version that is not current for removal after the grace
// period.
func (s *Server) DeleteVersion(ctx context.Context, req oapi.DeleteVersionRequestObject) (oapi.DeleteVersionResponseObject, error) {
	if _, err := s.authorizeNode(ctx, req.Id, permOwn); err != nil {
		return nil, err
	}
	if !blobs.ValidID(req.VersionId) {
		return nil, badRequest(codeInvalidID)
	}
	now := s.cfg.Now()
	removeAt, err := s.removalTime(ctx, now)
	if err != nil {
		return nil, err
	}
	v, err := s.store.DeleteVersion(ctx, req.Id, req.VersionId, now, removeAt)
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.DeleteVersion200JSONResponse(versionView(v)), nil
}
