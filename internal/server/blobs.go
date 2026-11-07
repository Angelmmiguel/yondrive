package server

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"os"
	"time"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// authorizeBlob loads a blob the caller may act on: through its node if it has
// one, and otherwise if it is theirs. Anything else answers as if it did not
// exist.
func (s *Server) authorizeBlob(ctx context.Context, id string, need permission) (store.Blob, error) {
	if !blobs.ValidID(id) {
		return store.Blob{}, badRequest(codeInvalidID)
	}
	b, err := s.store.BlobByID(ctx, id)
	if err != nil {
		return store.Blob{}, driveError(err)
	}
	if b.NodeID != "" {
		if _, err := s.authorizeNode(ctx, b.NodeID, need); err != nil {
			return store.Blob{}, err
		}
		return b, nil
	}
	if b.OwnerID != principalFrom(ctx).user.ID {
		return store.Blob{}, fail(http.StatusNotFound, codeNotFound)
	}
	return b, nil
}

// blobResponse streams a stored file. The headers are set here and not in the
// middleware because they are the point: these bytes come from a user, and a
// browser must never treat them as anything but a download.
type blobResponse struct {
	r    *http.Request
	file *os.File
	id   string
}

// VisitGetBlobResponse implements oapi.GetBlobResponseObject.
func (b blobResponse) VisitGetBlobResponse(w http.ResponseWriter) error {
	defer func() { _ = b.file.Close() }()
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", "attachment")
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("ETag", `"`+b.id+`"`)
	http.ServeContent(w, b.r, "", time.Time{}, b.file)
	return nil
}

// GetBlob serves a stored file, with Range.
func (s *Server) GetBlob(ctx context.Context, req oapi.GetBlobRequestObject) (oapi.GetBlobResponseObject, error) {
	b, err := s.authorizeBlob(ctx, req.Id, permRead)
	if err != nil {
		return nil, err
	}
	f, err := s.files.Open(b.ID)
	if err != nil {
		return nil, driveError(err)
	}
	return blobResponse{r: requestFrom(ctx), file: f, id: b.ID}, nil
}

func smallBlobView(b store.Blob) oapi.SmallBlob {
	return oapi.SmallBlob{
		Id:        b.ID,
		Kind:      oapi.SmallBlobKind(b.Kind),
		Suite:     oapi.Suite(b.Suite),
		Size:      b.Size,
		NodeId:    optional(b.NodeID),
		CreatedAt: b.CreatedAt,
	}
}

// PutSmallBlob stores a thumbnail, replacing any the node had, or an index segment.
func (s *Server) PutSmallBlob(ctx context.Context, req oapi.PutSmallBlobRequestObject) (oapi.PutSmallBlobResponseObject, error) {
	if !blobs.ValidID(req.Id) {
		return nil, badRequest(codeInvalidID)
	}
	if err := s.checkSuite(req.Params.Suite); err != nil {
		return nil, err
	}
	want, ok := decodeSHA256(req.Params.XContentSHA256)
	if !ok {
		return nil, badRequest(codeFrameHash)
	}
	b := store.Blob{
		ID:        req.Id,
		OwnerID:   principalFrom(ctx).user.ID,
		Kind:      string(req.Params.Kind),
		Suite:     string(req.Params.Suite),
		CreatedAt: s.cfg.Now(),
	}
	switch req.Params.Kind {
	case oapi.Thumb:
		if req.Params.NodeId == nil {
			return nil, badRequest(codeInvalidBlob)
		}
		n, err := s.authorizeNode(ctx, *req.Params.NodeId, permWrite)
		if err != nil {
			return nil, err
		}
		b.OwnerID, b.NodeID = n.OwnerID, n.ID
	case oapi.Index:
		if req.Params.NodeId != nil {
			return nil, badRequest(codeInvalidBlob)
		}
	default:
		return nil, badRequest(codeInvalidBlob)
	}

	tmp, size, sum, err := s.files.WriteTemp(req.Body, maxSmallBlob)
	if errors.Is(err, blobs.ErrTooLarge) {
		return nil, fail(http.StatusRequestEntityTooLarge, codeTooLarge)
	}
	if errors.Is(err, blobs.ErrBody) {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, err
		}
		return nil, badRequest(codeBadRequest)
	}
	if err != nil {
		return nil, driveError(err)
	}
	defer func() { _ = os.Remove(tmp) }()
	if !bytes.Equal(sum, want) {
		return nil, badRequest(codeFrameHash)
	}
	b.Size = size
	err = s.store.PutSmallBlob(ctx, b, func() error { return s.files.PlaceTemp(tmp, b.ID) })
	if err != nil {
		return nil, driveError(err)
	}
	s.drainRemovalsLogged(ctx)
	return oapi.PutSmallBlob201JSONResponse(smallBlobView(b)), nil
}

// DeleteSmallBlob removes a thumbnail or an index segment.
func (s *Server) DeleteSmallBlob(ctx context.Context, req oapi.DeleteSmallBlobRequestObject) (oapi.DeleteSmallBlobResponseObject, error) {
	b, err := s.authorizeBlob(ctx, req.Id, permWrite)
	if err != nil {
		return nil, err
	}
	if err := s.store.DeleteSmallBlob(ctx, b.ID, s.cfg.Now()); err != nil {
		return nil, driveError(err)
	}
	s.drainRemovalsLogged(ctx)
	return oapi.DeleteSmallBlob204Response{}, nil
}

// ListIndexBlobs returns a page of the caller's index segments.
func (s *Server) ListIndexBlobs(ctx context.Context, req oapi.ListIndexBlobsRequestObject) (oapi.ListIndexBlobsResponseObject, error) {
	after, err := idCursor(req.Params.Cursor)
	if err != nil {
		return nil, err
	}
	limit, err := pageLimit(req.Params.Limit)
	if err != nil {
		return nil, err
	}
	list, err := s.store.ListIndexBlobs(ctx, principalFrom(ctx).user.ID, after, limit+1)
	if err != nil {
		return nil, err
	}
	list, next := page(list, limit, func(b store.Blob) string { return b.ID })
	out := oapi.SmallBlobPage{Blobs: make([]oapi.SmallBlob, 0, len(list)), NextCursor: next}
	for _, b := range list {
		out.Blobs = append(out.Blobs, smallBlobView(b))
	}
	return oapi.ListIndexBlobs200JSONResponse(out), nil
}

// VisitGetPublicBlobResponse implements oapi.GetPublicBlobResponseObject.
func (b blobResponse) VisitGetPublicBlobResponse(w http.ResponseWriter) error {
	return b.VisitGetBlobResponse(w)
}
