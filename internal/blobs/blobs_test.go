package blobs

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const (
	idA = "ab000000000000000000000000000000"
	idB = "cd000000000000000000000000000000"
)

func open(t *testing.T) (*Dir, string) {
	t.Helper()
	root := t.TempDir()
	d, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	return d, root
}

func TestValidID(t *testing.T) {
	for _, id := range []string{idA, strings.Repeat("0", 32), strings.Repeat("f", 32)} {
		if !ValidID(id) {
			t.Errorf("refused %q", id)
		}
	}
	for _, id := range []string{
		"", "ab", strings.Repeat("0", 31), strings.Repeat("0", 33), strings.Repeat("A", 32), strings.Repeat("g", 32),
		"../../../../../../../etc/passwd", "..%2f" + strings.Repeat("0", 27), strings.Repeat("0", 31) + "/",
		strings.Repeat("0", 31) + "\x00", "ab/" + strings.Repeat("0", 29),
	} {
		if ValidID(id) {
			t.Errorf("accepted %q", id)
		}
	}
}

func TestEveryPathRefusesABadID(t *testing.T) {
	d, root := open(t)
	bad := "../" + strings.Repeat("0", 29)
	if err := os.WriteFile(filepath.Join(root, "victim"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, werr := d.WriteFrame(bad, 0, 1, strings.NewReader("x"))
	_, oerr := d.Open(bad)
	for name, err := range map[string]error{
		"CreateUpload":  d.CreateUpload(bad, 1),
		"WriteFrame":    werr,
		"PlaceUpload":   d.PlaceUpload(bad),
		"PlaceTemp":     d.PlaceTemp(filepath.Join(root, "victim"), bad),
		"UnplaceUpload": d.UnplaceUpload(bad),
		"Open":          oerr,
		"RemoveBlob":    d.RemoveBlob(bad),
		"RemoveUpload":  d.RemoveUpload(bad),
		"Export":        d.Export(bad, t.TempDir()),
	} {
		if !errors.Is(err, ErrInvalidID) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if d.HasUpload(bad) {
		t.Error("HasUpload accepted a bad id")
	}
	if _, err := os.Stat(filepath.Join(root, "victim")); err != nil {
		t.Errorf("the victim moved: %v", err)
	}
}

func TestFramesInAnyOrderThenPlace(t *testing.T) {
	d, root := open(t)
	if err := d.CreateUpload(idA, 9); err != nil {
		t.Fatal(err)
	}
	if err := d.CreateUpload(idA, 9); err == nil {
		t.Error("created an upload twice")
	}
	frames := []string{"aaa", "bbb", "ccc"}
	var wg sync.WaitGroup
	for i := 2; i >= 0; i-- {
		wg.Go(func() {
			sum, err := d.WriteFrame(idA, int64(i)*3, 3, strings.NewReader(frames[i]))
			want := sha256.Sum256([]byte(frames[i]))
			if err != nil || !bytes.Equal(sum, want[:]) {
				t.Errorf("frame %d: %x, %v", i, sum, err)
			}
		})
	}
	wg.Wait()
	if !d.HasUpload(idA) {
		t.Error("HasUpload is false")
	}
	if err := d.PlaceUpload(idA); err != nil {
		t.Fatal(err)
	}
	if d.HasUpload(idA) {
		t.Error("upload still there")
	}
	got, err := os.ReadFile(filepath.Join(root, "blobs", "ab", idA))
	if err != nil || string(got) != "aaabbbccc" {
		t.Errorf("blob = %q, %v", got, err)
	}
	// Placing again is a retried commit.
	if err := d.PlaceUpload(idA); err != nil {
		t.Errorf("retry: %v", err)
	}
	if err := d.PlaceUpload(idB); !errors.Is(err, ErrNotFound) {
		t.Errorf("no such upload: %v", err)
	}
	f, err := d.Open(idA)
	if err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	if _, err := d.Open(idB); !errors.Is(err, ErrNotFound) {
		t.Errorf("no such blob: %v", err)
	}
	if err := d.RemoveBlob(idA); err != nil {
		t.Fatal(err)
	}
	if err := d.RemoveBlob(idA); err != nil {
		t.Errorf("removed twice: %v", err)
	}
}

type failing struct{}

func (failing) Read([]byte) (int, error) { return 0, errors.New("connection lost") }

func TestWriteFrameChecksTheLength(t *testing.T) {
	d, _ := open(t)
	if err := d.CreateUpload(idA, 8); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"short": "abc", "long": "abcde", "empty": ""} {
		if _, err := d.WriteFrame(idA, 0, 4, strings.NewReader(body)); !errors.Is(err, ErrLength) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := d.WriteFrame(idA, 0, 4, io.MultiReader(strings.NewReader("ab"), failing{})); !errors.Is(err, ErrBody) {
		t.Errorf("body failure: %v", err)
	}
	if _, err := d.WriteFrame(idB, 0, 1, strings.NewReader("a")); !errors.Is(err, ErrNotFound) {
		t.Errorf("no upload: %v", err)
	}
	if sum, err := d.WriteFrame(idA, 0, 0, strings.NewReader("")); err != nil || len(sum) != sha256.Size {
		t.Errorf("empty frame: %x, %v", sum, err)
	}
}

func TestTempFiles(t *testing.T) {
	d, root := open(t)
	path, size, sum, err := d.WriteTemp(strings.NewReader("hello"), 5)
	want := sha256.Sum256([]byte("hello"))
	if err != nil || size != 5 || !bytes.Equal(sum, want[:]) {
		t.Fatalf("temp = %d %x, %v", size, sum, err)
	}
	if err := d.PlaceTemp(path, idB); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "blobs", "cd", idB)); string(got) != "hello" {
		t.Errorf("placed %q", got)
	}
	if _, _, _, err := d.WriteTemp(strings.NewReader("too long"), 5); !errors.Is(err, ErrTooLarge) {
		t.Errorf("too long: %v", err)
	}
	if _, _, _, err := d.WriteTemp(failing{}, 5); !errors.Is(err, ErrBody) {
		t.Errorf("failing: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "uploads"))
	if len(entries) != 0 {
		t.Errorf("left behind: %v", entries)
	}
}

func TestCleanTempKeepsUploads(t *testing.T) {
	d, root := open(t)
	if err := d.CreateUpload(idA, 1); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "uploads", "tmp-123"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	ids, err := d.CleanTemp()
	if err != nil || len(ids) != 1 || ids[0] != idA {
		t.Errorf("ids = %v, %v", ids, err)
	}
	if _, err := os.Stat(filepath.Join(root, "uploads", "tmp-123")); err == nil {
		t.Error("temp file survived")
	}
}

func TestUnplace(t *testing.T) {
	d, _ := open(t)
	if err := d.CreateUpload(idA, 1); err != nil {
		t.Fatal(err)
	}
	if err := d.PlaceUpload(idA); err != nil {
		t.Fatal(err)
	}
	if err := d.UnplaceUpload(idA); err != nil {
		t.Fatal(err)
	}
	if !d.HasUpload(idA) {
		t.Error("not back")
	}
}

func TestEachShard(t *testing.T) {
	d, root := open(t)
	for _, id := range []string{idA, idB} {
		if err := d.CreateUpload(id, 0); err != nil {
			t.Fatal(err)
		}
		if err := d.PlaceUpload(id); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "blobs", "ab", "stray"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	got := map[string][]string{}
	err := d.EachShard(func(shard string, ids []string) error { got[shard] = ids; return nil })
	if err != nil || len(got) != 2 || len(got["ab"]) != 1 || got["ab"][0] != idA || got["cd"][0] != idB {
		t.Errorf("shards = %v, %v", got, err)
	}
	boom := errors.New("boom")
	if err := d.EachShard(func(string, []string) error { return boom }); !errors.Is(err, boom) {
		t.Errorf("error lost: %v", err)
	}
}

func TestExportLinksOrCopies(t *testing.T) {
	d, _ := open(t)
	if err := d.CreateUpload(idA, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := d.WriteFrame(idA, 0, 2, strings.NewReader("hi")); err != nil {
		t.Fatal(err)
	}
	if err := d.PlaceUpload(idA); err != nil {
		t.Fatal(err)
	}
	dest := t.TempDir()
	if err := d.Export(idA, dest); err != nil {
		t.Fatal(err)
	}
	// Removing the source leaves the export.
	if err := d.RemoveBlob(idA); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(dest, "blobs", "ab", idA)); err != nil || string(got) != "hi" {
		t.Errorf("export = %q, %v", got, err)
	}
	// Already there is no error, even with the source gone.
	if err := d.Export(idA, dest); err != nil {
		t.Errorf("second export: %v", err)
	}
	if err := d.Export(idB, dest); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing source: %v", err)
	}
	if err := SyncExport(dest); err != nil {
		t.Errorf("sync: %v", err)
	}
	if err := SyncExport(t.TempDir()); err != nil {
		t.Errorf("sync of an empty backup: %v", err)
	}
	if err := At(t.TempDir()).EachShard(func(string, []string) error { return errors.New("called") }); err != nil {
		t.Errorf("a backup with no files: %v", err)
	}
}

func TestCopyFile(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "src"), filepath.Join(dir, "dst")
	if err := os.WriteFile(src, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(dst); err != nil || string(got) != "data" {
		t.Errorf("copy = %q, %v", got, err)
	}
	if err := copyFile(filepath.Join(dir, "none"), dst); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing: %v", err)
	}
}
