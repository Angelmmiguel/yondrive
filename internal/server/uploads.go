package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/blobs"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Limits of uploads. frameOverhead is what sealing adds to a frame in end-to-end
// mode (CRYPTO.md, section 1). signatureLen is that of Ed25519.
const (
	// MaxFrameSize is the largest plaintext frame the server takes. CRYPTO.md
	// lets a format go higher, and new versions use 4 MiB.
	MaxFrameSize  = 16 << 20
	minFrameSize  = 1024
	maxFrameCount = 1 << 20
	frameOverhead = 41
	signatureLen  = 64
	maxManifest   = 4 << 10
	// maxSmallBlob is the largest thumbnail or index segment. A larger index is
	// more segments.
	maxSmallBlob = MaxFrameSize
	// maxBodyBytes is the largest body of a frame or a small blob.
	maxBodyBytes = MaxFrameSize + frameOverhead
)

// largeBodyRoute reports whether a request may carry a frame, a small blob or the
// keys of a whole folder, rather than a small JSON document. These get a larger cap
// and more time to arrive.
func largeBodyRoute(r *http.Request) bool {
	if r.Method == http.MethodPost {
		rest, ok := strings.CutPrefix(r.URL.Path, "/api/v1/nodes/")
		id, op, found := strings.Cut(rest, "/")
		return ok && found && op == "rotate" && blobs.ValidID(id)
	}
	if r.Method != http.MethodPut {
		return false
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, "/api/v1/blobs/"); ok {
		return !strings.Contains(rest, "/")
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, "/api/v1/uploads/"); ok {
		_, n, found := strings.Cut(rest, "/frames/")
		return found && !strings.Contains(n, "/")
	}
	return false
}

// framing is how an upload's stored file is cut.
type framing struct {
	count, stride, stored int64
}

// framingOf builds the framing of a version, and reports whether its sizes fit
// CRYPTO.md, section 11: every frame but the last is full, and the last one holds
// some plaintext unless it is the only one.
func framingOf(frameCount, frameSize, stored int64, overhead int64) (framing, bool) {
	if frameCount < 1 || frameCount > maxFrameCount || frameSize < minFrameSize || frameSize > MaxFrameSize || stored < 0 {
		return framing{}, false
	}
	f := framing{count: frameCount, stride: frameSize + overhead, stored: stored}
	last := f.length(frameCount - 1)
	floor := overhead
	if frameCount > 1 {
		floor++
	}
	return f, last >= floor && last <= f.stride
}

// length is how long a stored frame must be.
func (f framing) length(n int64) int64 {
	if n == f.count-1 {
		return f.stored - (f.count-1)*f.stride
	}
	return f.stride
}

func (f framing) offset(n int64) int64 { return n * f.stride }

func (s *Server) overhead() int64 {
	if s.suite() == oapi.SuiteNone {
		return 0
	}
	return frameOverhead
}

// frameLocks lets one request at a time write a given frame, since each writes
// in place, and a recorded digest must describe the bytes on disk. A request
// waits for its turn only as long as it lives.
type frameLocks struct {
	mu   sync.Mutex
	busy map[string]chan struct{}
}

func newFrameLocks() *frameLocks { return &frameLocks{busy: map[string]chan struct{}{}} }

func (l *frameLocks) acquire(ctx context.Context, key string) (release func(), err error) {
	for {
		l.mu.Lock()
		held, ok := l.busy[key]
		if !ok {
			done := make(chan struct{})
			l.busy[key] = done
			l.mu.Unlock()
			return func() {
				l.mu.Lock()
				delete(l.busy, key)
				l.mu.Unlock()
				close(done)
			}, nil
		}
		l.mu.Unlock()
		select {
		case <-held:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// authorizeUpload loads an upload of the caller's, on a node they can still
// write to.
func (s *Server) authorizeUpload(ctx context.Context, id string) (store.Upload, error) {
	if !blobs.ValidID(id) {
		return store.Upload{}, badRequest(codeInvalidID)
	}
	u, err := s.store.UploadByID(ctx, id)
	if err != nil {
		return store.Upload{}, driveError(err)
	}
	if u.UserID != principalFrom(ctx).user.ID {
		return store.Upload{}, fail(http.StatusNotFound, codeNotFound)
	}
	if _, err := s.authorizeNode(ctx, u.NodeID, permWrite); err != nil {
		return store.Upload{}, err
	}
	return u, nil
}

func uploadView(u store.Upload, frames []int64) oapi.Upload {
	generation := u.KeyGeneration
	return oapi.Upload{
		KeyGeneration: &generation,
		Id:            u.ID,
		NodeId:        u.NodeID,
		VersionId:     u.VersionID,
		Suite:         oapi.Suite(u.Suite),
		FrameCount:    u.FrameCount,
		FrameSize:     u.FrameSize,
		StoredSize:    u.StoredSize,
		Frames:        frames,
		CreatedAt:     u.CreatedAt,
	}
}

// CreateUpload reserves room for a version of a file. The row comes first: no
// client has this id until the file exists too, and if a crash comes in between,
// the check at startup drops the row.
func (s *Server) CreateUpload(ctx context.Context, req oapi.CreateUploadRequestObject) (oapi.CreateUploadResponseObject, error) {
	in := req.Body
	if !blobs.ValidID(in.VersionId) {
		return nil, badRequest(codeInvalidID)
	}
	if err := s.checkSuite(in.Suite); err != nil {
		return nil, err
	}
	if _, ok := framingOf(in.FrameCount, in.FrameSize, in.StoredSize, s.overhead()); !ok {
		return nil, badRequest(codeInvalidFraming)
	}
	if _, err := s.authorizeNode(ctx, in.NodeId, permWrite); err != nil {
		return nil, err
	}
	var generation int64
	if in.KeyGeneration != nil {
		if *in.KeyGeneration < 1 {
			return nil, fail(http.StatusPreconditionFailed, codeKeyGenerationConflict)
		}
		generation = *in.KeyGeneration
	}
	id := store.NewID()
	u, err := s.store.CreateUpload(ctx, store.Upload{
		KeyGeneration: generation,
		ID:            id,
		UserID:        principalFrom(ctx).user.ID,
		NodeID:        in.NodeId,
		VersionID:     in.VersionId,
		Suite:         string(in.Suite),
		FrameCount:    in.FrameCount,
		FrameSize:     in.FrameSize,
		StoredSize:    in.StoredSize,
		CreatedAt:     s.cfg.Now(),
	})
	if err != nil {
		return nil, driveError(err)
	}
	if err := s.files.CreateUpload(id, in.StoredSize); err != nil {
		if derr := s.store.DeleteUpload(context.WithoutCancel(ctx), id); derr != nil {
			s.log.Error("upload row left behind", "error", derr)
		}
		return nil, driveError(err)
	}
	return oapi.CreateUpload201JSONResponse(uploadView(u, []int64{})), nil
}

// GetUpload reports which frames have arrived.
func (s *Server) GetUpload(ctx context.Context, req oapi.GetUploadRequestObject) (oapi.GetUploadResponseObject, error) {
	u, err := s.authorizeUpload(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	frames, err := s.store.UploadedFrames(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	return oapi.GetUpload200JSONResponse(uploadView(u, frames)), nil
}

// AbortUpload drops an upload and releases its reservation.
func (s *Server) AbortUpload(ctx context.Context, req oapi.AbortUploadRequestObject) (oapi.AbortUploadResponseObject, error) {
	u, err := s.authorizeUpload(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	if err := s.store.DeleteUpload(ctx, u.ID); err != nil {
		return nil, driveError(err)
	}
	s.drainRemovalsLogged(ctx)
	return oapi.AbortUpload204Response{}, nil
}

func decodeSHA256(v string) ([]byte, bool) {
	sum, err := base64.StdEncoding.Strict().DecodeString(v)
	return sum, err == nil && len(sum) == 32
}

// PutFrame stores one frame of an upload. It is on disk before it is recorded, so
// what status reports as present is there after a crash.
//
// A frame already recorded is never written again. That is what makes a commit
// safe against a late retry: no writer can be touching a file with every frame
// recorded.
func (s *Server) PutFrame(ctx context.Context, req oapi.PutFrameRequestObject) (oapi.PutFrameResponseObject, error) {
	u, err := s.authorizeUpload(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	want, ok := decodeSHA256(req.Params.XContentSHA256)
	if !ok {
		return nil, badRequest(codeFrameHash)
	}
	if req.N < 0 || req.N >= u.FrameCount {
		return nil, badRequest(codeInvalidFrame)
	}
	f, ok := framingOf(u.FrameCount, u.FrameSize, u.StoredSize, s.overhead())
	if !ok {
		return nil, badRequest(codeInvalidFraming)
	}
	length := f.length(req.N)
	if r := requestFrom(ctx); r != nil && r.ContentLength >= 0 && r.ContentLength != length {
		return nil, badRequest(codeFrameLength)
	}

	release, err := s.frames.acquire(ctx, u.ID+"/"+strconv.FormatInt(req.N, 10))
	if err != nil {
		return nil, err
	}
	defer release()

	existing, err := s.store.FrameHash(ctx, u.ID, req.N)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if !bytes.Equal(existing, want) {
			return nil, fail(http.StatusConflict, codeFrameConflict)
		}
		return oapi.PutFrame204Response{}, nil
	}
	sum, err := s.files.WriteFrame(u.ID, f.offset(req.N), length, req.Body)
	switch {
	case errors.Is(err, blobs.ErrLength):
		return nil, badRequest(codeFrameLength)
	case errors.Is(err, blobs.ErrBody):
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, err
		}
		return nil, badRequest(codeFrameLength)
	case err != nil:
		return nil, driveError(err)
	}
	if !bytes.Equal(sum, want) {
		return nil, badRequest(codeFrameHash)
	}
	// The client may hang up now that it has sent everything; the frame is good.
	if err := s.store.RecordFrame(context.WithoutCancel(ctx), u.ID, req.N, sum, s.cfg.Now()); err != nil {
		return nil, driveError(err)
	}
	return oapi.PutFrame204Response{}, nil
}

// CommitUpload turns a complete upload into the file's current version. It goes
// on even if the client hangs up, as a half-done commit helps no one.
func (s *Server) CommitUpload(ctx context.Context, req oapi.CommitUploadRequestObject) (oapi.CommitUploadResponseObject, error) {
	ctx = context.WithoutCancel(ctx)
	in := req.Body
	if len(in.Manifest) < 1 || len(in.Manifest) > maxManifest {
		return nil, badRequest(codeInvalidCommit)
	}
	wantSignature := signatureLen
	if s.suite() == oapi.SuiteNone {
		wantSignature = 0
	}
	if len(in.Signature) != wantSignature {
		return nil, badRequest(codeInvalidCommit)
	}
	if _, err := s.authorizeUpload(ctx, req.Id); err != nil {
		return nil, err
	}
	// A commit that fails after placing the file leaves it placed. Moving it back
	// here could undo a retry that has succeeded in the meantime, and lose the
	// blob's file. PlaceUpload is content with a file already in place, so a retry
	// goes through, and startup moves back what no retry took up.
	v, err := s.store.CommitUpload(ctx, req.Id, store.CommitRequest{
		Signature: in.Signature,
		Manifest:  in.Manifest,
		Expected:  in.ExpectedVersion,
	}, s.cfg.Now(), func(u store.Upload) error { return s.files.PlaceUpload(u.ID) })
	if err != nil {
		return nil, driveError(err)
	}
	return oapi.CommitUpload201JSONResponse(versionView(v)), nil
}
