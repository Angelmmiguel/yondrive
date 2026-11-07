// Package blobs keeps stored files in the data directory: one file per version,
// thumbnail or index segment, with no idea of what is in them. The layout is
//
//	blobs/<id[:2]>/<id>   finished files, which never change
//	uploads/<id>          versions being uploaded
//	uploads/tmp-*         small files on their way in
//
// Every path is built from an id that passed ValidID, so that nothing a client
// sends can walk out of these directories.
package blobs

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	dirPerm    fs.FileMode = 0o700
	blobsDir               = "blobs"
	uploadsDir             = "uploads"
	tmpPrefix              = "tmp-"
	idLen                  = 32
	shardLen               = 2
	copyBuffer             = 256 << 10
)

// Errors of the package. Callers match them with errors.Is.
var (
	// ErrInvalidID means the id is not 32 lowercase hex characters.
	ErrInvalidID = errors.New("blobs: invalid id")
	// ErrNotFound means there is no such file.
	ErrNotFound = errors.New("blobs: not found")
	// ErrLength means the body was not exactly as long as it had to be.
	ErrLength = errors.New("blobs: wrong length")
	// ErrBody means the body could not be read to its end.
	ErrBody = errors.New("blobs: body failed")
	// ErrTooLarge means the body went past the limit.
	ErrTooLarge = errors.New("blobs: too large")
)

// ValidID reports whether id can become a file name.
func ValidID(id string) bool {
	if len(id) != idLen {
		return false
	}
	for i := range len(id) {
		if c := id[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Dir is the stored files of one data directory.
type Dir struct {
	root string
}

// At returns the stored files under a directory as it stands, such as a backup.
func At(root string) *Dir { return &Dir{root: root} }

// Open prepares the directories under a data directory.
func Open(dataDir string) (*Dir, error) {
	d := &Dir{root: dataDir}
	for _, sub := range []string{blobsDir, uploadsDir} {
		if err := os.MkdirAll(filepath.Join(dataDir, sub), dirPerm); err != nil {
			return nil, fmt.Errorf("blobs: create %s: %w", sub, err)
		}
	}
	return d, nil
}

func blobPath(root, id string) string {
	return filepath.Join(root, blobsDir, id[:shardLen], id)
}

func (d *Dir) uploadPath(id string) string {
	return filepath.Join(d.root, uploadsDir, id)
}

// CreateUpload makes the file of a new upload at its final size. Until the frames
// arrive it is sparse, so a reservation costs no disk.
func (d *Dir) CreateUpload(id string, size int64) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	f, err := os.OpenFile(d.uploadPath(id), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("blobs: create upload: %w", err)
	}
	if err := errors.Join(f.Truncate(size), f.Sync(), f.Close()); err != nil {
		_ = os.Remove(f.Name())
		return fmt.Errorf("blobs: create upload: %w", err)
	}
	return syncDir(filepath.Join(d.root, uploadsDir))
}

// WriteFrame writes the body at offset in an upload's file and returns its
// SHA-256. The body must be exactly length bytes. On any failure the bytes
// written stay in the file, unrecorded, for a retry to overwrite. On success
// they are on disk.
func (d *Dir) WriteFrame(id string, offset, length int64, body io.Reader) ([]byte, error) {
	if !ValidID(id) {
		return nil, ErrInvalidID
	}
	f, err := os.OpenFile(d.uploadPath(id), os.O_WRONLY, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("blobs: open upload: %w", err)
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := copyBody(io.MultiWriter(io.NewOffsetWriter(f, offset), h), body, length)
	if err != nil {
		return nil, err
	}
	if n != length {
		return nil, ErrLength
	}
	if err := f.Sync(); err != nil {
		return nil, fmt.Errorf("blobs: sync upload: %w", err)
	}
	return h.Sum(nil), nil
}

// copyBody copies the body to w up to limit bytes, and reads on to check that it
// ends there. It keeps a failing body apart from a failing disk, which copying
// helpers do not.
func copyBody(w io.Writer, body io.Reader, limit int64) (int64, error) {
	buf := make([]byte, copyBuffer)
	var total int64
	for {
		want := min(int64(len(buf)), limit-total)
		if want == 0 {
			var one [1]byte
			n, err := io.ReadFull(body, one[:])
			if n > 0 {
				return total, ErrLength
			}
			if err != nil && !errors.Is(err, io.EOF) {
				return total, fmt.Errorf("%w: %w", ErrBody, err)
			}
			return total, nil
		}
		n, err := body.Read(buf[:want])
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return total, fmt.Errorf("blobs: write: %w", werr)
			}
			total += int64(n)
		}
		if errors.Is(err, io.EOF) {
			return total, nil
		}
		if err != nil {
			return total, fmt.Errorf("%w: %w", ErrBody, err)
		}
	}
}

// PlaceUpload moves a finished upload to its final place, atomically and durably:
// the file first, then the directory entries on both sides, as nothing may rely
// on the move before it has reached the disk. A second call after the file got
// there succeeds, so that a commit can be retried.
func (d *Dir) PlaceUpload(id string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	src, dst := d.uploadPath(id), blobPath(d.root, id)
	f, err := os.Open(src)
	if errors.Is(err, fs.ErrNotExist) {
		if _, serr := os.Stat(dst); serr == nil {
			return nil
		}
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("blobs: open upload: %w", err)
	}
	if err := errors.Join(f.Sync(), f.Close()); err != nil {
		return fmt.Errorf("blobs: sync upload: %w", err)
	}
	return d.move(src, dst)
}

// WriteTemp reads a small body into a temporary file, on disk when it returns,
// and returns its path, size and SHA-256. Above limit it fails with ErrTooLarge.
// Nothing is left behind on failure.
func (d *Dir) WriteTemp(body io.Reader, limit int64) (path string, size int64, sum []byte, err error) {
	f, err := os.CreateTemp(filepath.Join(d.root, uploadsDir), tmpPrefix)
	if err != nil {
		return "", 0, nil, fmt.Errorf("blobs: create temp: %w", err)
	}
	defer func() {
		if err != nil {
			_ = f.Close()
			_ = os.Remove(f.Name())
		}
	}()
	h := sha256.New()
	size, err = copyBody(io.MultiWriter(f, h), body, limit)
	if errors.Is(err, ErrLength) {
		return "", 0, nil, ErrTooLarge
	}
	if err != nil {
		return "", 0, nil, err
	}
	if err = errors.Join(f.Sync(), f.Close()); err != nil {
		return "", 0, nil, fmt.Errorf("blobs: sync temp: %w", err)
	}
	return f.Name(), size, h.Sum(nil), nil
}

// PlaceTemp moves a file from WriteTemp to its final place.
func (d *Dir) PlaceTemp(tmp, id string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	return d.move(tmp, blobPath(d.root, id))
}

func (d *Dir) move(src, dst string) error {
	if err := d.ensureShard(filepath.Dir(dst)); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		return fmt.Errorf("blobs: place: %w", err)
	}
	return errors.Join(syncDir(filepath.Dir(dst)), syncDir(filepath.Dir(src)))
}

// ensureShard creates a shard directory the first time a file lands in it, and
// syncs its parent, so that the entry survives a power cut together with the
// file. Two calls at once both succeed.
func (d *Dir) ensureShard(dir string) error {
	if _, err := os.Stat(dir); err == nil {
		return nil
	}
	if err := os.Mkdir(dir, dirPerm); err != nil && !errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("blobs: create shard: %w", err)
	}
	return syncDir(filepath.Dir(dir))
}

// UnplaceUpload moves a placed file back, for a commit that never finished.
func (d *Dir) UnplaceUpload(id string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	if err := os.Rename(blobPath(d.root, id), d.uploadPath(id)); err != nil {
		return fmt.Errorf("blobs: unplace: %w", err)
	}
	return nil
}

// Open returns a finished file for reading.
func (d *Dir) Open(id string) (*os.File, error) {
	if !ValidID(id) {
		return nil, ErrInvalidID
	}
	f, err := os.Open(blobPath(d.root, id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("blobs: open: %w", err)
	}
	return f, nil
}

// HasUpload reports whether an upload's file is there.
func (d *Dir) HasUpload(id string) bool {
	if !ValidID(id) {
		return false
	}
	_, err := os.Stat(d.uploadPath(id))
	return err == nil
}

// RemoveBlob unlinks a finished file, and is content if it is gone already.
func (d *Dir) RemoveBlob(id string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	return removeFile(blobPath(d.root, id))
}

// RemoveUpload unlinks an upload's file, and is content if it is gone already.
func (d *Dir) RemoveUpload(id string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	return removeFile(d.uploadPath(id))
}

func removeFile(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("blobs: remove: %w", err)
	}
	return nil
}

// CleanTemp removes small files that a crash left on their way in, and returns
// the ids of the upload files that are there. It is for startup: nothing may be
// writing at the same time.
func (d *Dir) CleanTemp() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(d.root, uploadsDir))
	if err != nil {
		return nil, fmt.Errorf("blobs: read uploads: %w", err)
	}
	var ids []string
	for _, e := range entries {
		if ValidID(e.Name()) {
			ids = append(ids, e.Name())
		} else if err := removeFile(filepath.Join(d.root, uploadsDir, e.Name())); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// EachShard calls fn with each shard and the ids of the files in it.
func (d *Dir) EachShard(fn func(shard string, ids []string) error) error {
	shards, err := os.ReadDir(filepath.Join(d.root, blobsDir))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("blobs: read blobs: %w", err)
	}
	for _, shard := range shards {
		if !shard.IsDir() || len(shard.Name()) != shardLen {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(d.root, blobsDir, shard.Name()))
		if err != nil {
			return fmt.Errorf("blobs: read shard: %w", err)
		}
		ids := make([]string, 0, len(entries))
		for _, e := range entries {
			if ValidID(e.Name()) && strings.HasPrefix(e.Name(), shard.Name()) {
				ids = append(ids, e.Name())
			}
		}
		if err := fn(shard.Name(), ids); err != nil {
			return err
		}
	}
	return nil
}

// Export puts a finished file into another data directory, as a hard link where
// it can, since it never changes, and otherwise as a copy. A file already there
// is left alone. It fails with ErrNotFound if the file is gone.
func (d *Dir) Export(id, destRoot string) error {
	if !ValidID(id) {
		return ErrInvalidID
	}
	src, dst := blobPath(d.root, id), blobPath(destRoot, id)
	if _, err := os.Stat(dst); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dst), dirPerm); err != nil {
		return fmt.Errorf("blobs: create shard: %w", err)
	}
	err := os.Link(src, dst)
	if err == nil {
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		if _, serr := os.Stat(src); errors.Is(serr, fs.ErrNotExist) {
			return ErrNotFound
		}
	}
	return copyFile(src, dst)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("blobs: open: %w", err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.CreateTemp(filepath.Dir(dst), tmpPrefix)
	if err != nil {
		return fmt.Errorf("blobs: create copy: %w", err)
	}
	defer func() { _ = os.Remove(out.Name()) }()
	_, err = io.Copy(out, in)
	if err = errors.Join(err, out.Sync(), out.Close()); err != nil {
		return fmt.Errorf("blobs: copy: %w", err)
	}
	if err := os.Rename(out.Name(), dst); err != nil {
		return fmt.Errorf("blobs: place copy: %w", err)
	}
	return nil
}

// SyncExport makes a whole exported tree durable, once it is complete: a hard
// link needs its directory entry on disk too.
func SyncExport(destRoot string) error {
	root := filepath.Join(destRoot, blobsDir)
	if _, err := os.Stat(root); errors.Is(err, fs.ErrNotExist) {
		return syncDir(destRoot)
	}
	err := filepath.WalkDir(root, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if e.IsDir() {
			return syncDir(path)
		}
		return nil
	})
	if err != nil {
		return err
	}
	return syncDir(destRoot)
}

func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("blobs: open dir: %w", err)
	}
	defer func() { _ = d.Close() }()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("blobs: sync dir: %w", err)
	}
	return nil
}
