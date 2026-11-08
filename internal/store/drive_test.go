package store

import (
	"bytes"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const suiteTest = "none"

func tag(s string) []byte { return bytes.Repeat([]byte(s), 32)[:32] }

func root(t *testing.T, st *Store, owner string) Node {
	t.Helper()
	n, created, err := st.CreateRoot(ctx, Node{ID: NewID(), OwnerID: owner, Suite: suiteTest, CreatedAt: t0})
	if err != nil || !created {
		t.Fatalf("CreateRoot: %v, created %v", err, created)
	}
	return n
}

func child(id, owner, parent, kind, name string) Node {
	return Node{ID: id, OwnerID: owner, ParentID: parent, Kind: kind, Suite: suiteTest,
		SealedMetadata: []byte{}, NameTag: tag(name), CreatedAt: t0}
}

func addNode(t *testing.T, st *Store, owner, parent, kind, name string) Node {
	t.Helper()
	n, err := st.CreateNode(ctx, child(NewID(), owner, parent, kind, name), nil)
	if err != nil {
		t.Fatalf("CreateNode %s: %v", name, err)
	}
	return n
}

func wantErr(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Errorf("got %v, want %v", err, want)
	}
}

func placed(Upload) error { return nil }

// commit makes a one-frame version of a file, with the file system left out.
func commit(t *testing.T, st *Store, owner, node, version string, size int64, expected *string) Version {
	t.Helper()
	id := NewID()
	if _, err := st.CreateUpload(ctx, Upload{ID: id, UserID: owner, NodeID: node, VersionID: version, Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: size, CreatedAt: t0}); err != nil {
		t.Fatalf("CreateUpload: %v", err)
	}
	if err := st.RecordFrame(ctx, id, 0, tag("f"), t0); err != nil {
		t.Fatalf("RecordFrame: %v", err)
	}
	v, err := st.CommitUpload(ctx, id, CommitRequest{Manifest: []byte("m"), Expected: expected}, t0, placed)
	if err != nil {
		t.Fatalf("CommitUpload: %v", err)
	}
	return v
}

func usage(t *testing.T, st *Store, id string) Usage {
	t.Helper()
	u, err := st.UsageOf(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestRootIsOnDemandAndSingle(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	if _, err := st.RootNode(ctx, u.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no root yet: %v", err)
	}
	first := root(t, st, u.ID)
	second, created, err := st.CreateRoot(ctx, Node{ID: NewID(), OwnerID: u.ID, Suite: suiteTest, CreatedAt: t0})
	if err != nil || created || second.ID != first.ID {
		t.Errorf("second root = %+v, %v, %v", second, created, err)
	}
	if got, err := st.RootNode(ctx, u.ID); err != nil || got.ID != first.ID || got.Kind != KindFolder {
		t.Errorf("root = %+v, %v", got, err)
	}
	_, err = st.TrashNode(ctx, first.ID, t0)
	wantErr(t, err, ErrRootImmutable)
	folder := addNode(t, st, u.ID, first.ID, KindFolder, "a")
	_, err = st.MoveNode(ctx, first.ID, folder.ID, nil, tag("x"), MoveGuard{}, t0)
	wantErr(t, err, ErrRootImmutable)
	_, err = st.UpdateNode(ctx, first.ID, nil, tag("x"), KeyCheck{}, t0)
	wantErr(t, err, ErrRootImmutable)
}

func TestCreateNodeRules(t *testing.T) {
	st := open(t)
	u, other := addUser(t, st, "alice"), addUser(t, st, "bob")
	r := root(t, st, u.ID)
	otherRoot := root(t, st, other.ID)

	file := addNode(t, st, u.ID, r.ID, KindFile, "a")

	_, err := st.CreateNode(ctx, child(file.ID, u.ID, r.ID, KindFile, "b"), nil)
	wantErr(t, err, ErrIDTaken)
	_, err = st.CreateNode(ctx, child(NewID(), u.ID, r.ID, KindFolder, "a"), nil)
	wantErr(t, err, ErrNameConflict)
	_, err = st.CreateNode(ctx, child(NewID(), u.ID, file.ID, KindFile, "b"), nil)
	wantErr(t, err, ErrNotFolder)
	_, err = st.CreateNode(ctx, child(NewID(), u.ID, NewID(), KindFile, "b"), nil)
	wantErr(t, err, ErrNotFound)
	_, err = st.CreateNode(ctx, child(NewID(), u.ID, otherRoot.ID, KindFile, "b"), nil)
	wantErr(t, err, ErrNotFound)

	// A trashed sibling frees its name, and returning it needs the name back.
	if _, err := st.TrashNode(ctx, file.ID, t0); err != nil {
		t.Fatal(err)
	}
	replacement := addNode(t, st, u.ID, r.ID, KindFile, "a")
	_, err = st.RestoreNode(ctx, file.ID, t0)
	wantErr(t, err, ErrNameConflict)
	if _, err := st.TrashNode(ctx, replacement.ID, t0); err != nil {
		t.Fatal(err)
	}
	if got, err := st.RestoreNode(ctx, file.ID, t0); err != nil || !got.TrashedAt.IsZero() {
		t.Errorf("restore = %+v, %v", got, err)
	}
}

func TestChildrenPageByID(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	var nodes []Node
	for i := range 5 {
		nodes = append(nodes, addNode(t, st, u.ID, r.ID, KindFile, fmt.Sprint(i)))
	}
	if _, err := st.TrashNode(ctx, nodes[0].ID, t0); err != nil {
		t.Fatal(err)
	}
	var seen []string
	after := ""
	for {
		page, err := st.ListChildren(ctx, r.ID, after, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) == 0 {
			break
		}
		for _, n := range page {
			if after >= n.ID {
				t.Errorf("out of order: %s after %s", n.ID, after)
			}
			after = n.ID
			seen = append(seen, n.ID)
		}
	}
	if len(seen) != 4 {
		t.Errorf("saw %d children, want 4", len(seen))
	}
	trash, err := st.ListTrash(ctx, u.ID, "", 10)
	if err != nil || len(trash) != 1 || trash[0].ID != nodes[0].ID {
		t.Errorf("trash = %+v, %v", trash, err)
	}
}

func TestMoveRules(t *testing.T) {
	st := open(t)
	u, other := addUser(t, st, "alice"), addUser(t, st, "bob")
	r := root(t, st, u.ID)
	a := addNode(t, st, u.ID, r.ID, KindFolder, "a")
	b := addNode(t, st, u.ID, a.ID, KindFolder, "b")
	c := addNode(t, st, u.ID, b.ID, KindFolder, "c")
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	addNode(t, st, u.ID, c.ID, KindFile, "taken")

	for _, target := range []string{a.ID, b.ID, c.ID} {
		_, err := st.MoveNode(ctx, a.ID, target, []byte("k"), tag("x"), MoveGuard{}, t0)
		wantErr(t, err, ErrMoveCycle)
	}
	_, err := st.MoveNode(ctx, a.ID, f.ID, []byte("k"), tag("x"), MoveGuard{}, t0)
	wantErr(t, err, ErrNotFolder)
	_, err = st.MoveNode(ctx, f.ID, c.ID, []byte("k"), tag("taken"), MoveGuard{}, t0)
	wantErr(t, err, ErrNameConflict)
	otherRoot := root(t, st, other.ID)
	_, err = st.MoveNode(ctx, f.ID, otherRoot.ID, []byte("k"), tag("x"), MoveGuard{}, t0)
	wantErr(t, err, ErrMoveAcrossOwners)

	got, err := st.MoveNode(ctx, f.ID, c.ID, []byte("new key"), tag("moved"), MoveGuard{}, t0.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if got.ParentID != c.ID || !bytes.Equal(got.WrappedKey, []byte("new key")) || !bytes.Equal(got.NameTag, tag("moved")) ||
		!got.UpdatedAt.Equal(t0.Add(time.Second)) {
		t.Errorf("moved = %+v", got)
	}

	// Nothing moves into or out of the trash.
	if _, err := st.TrashNode(ctx, c.ID, t0); err != nil {
		t.Fatal(err)
	}
	_, err = st.MoveNode(ctx, a.ID, c.ID, []byte("k"), tag("x"), MoveGuard{}, t0)
	wantErr(t, err, ErrMoveCycle)
	d := addNode(t, st, u.ID, r.ID, KindFolder, "d")
	_, err = st.MoveNode(ctx, d.ID, c.ID, []byte("k"), tag("x"), MoveGuard{}, t0)
	wantErr(t, err, ErrParentTrashed)
	_, err = st.MoveNode(ctx, f.ID, r.ID, []byte("k"), tag("x"), MoveGuard{}, t0)
	wantErr(t, err, ErrNodeTrashed)
	_, err = st.CreateNode(ctx, child(NewID(), u.ID, c.ID, KindFile, "n"), nil)
	wantErr(t, err, ErrParentTrashed)
	_, err = st.UpdateNode(ctx, f.ID, []byte("m"), nil, KeyCheck{}, t0)
	wantErr(t, err, ErrNodeTrashed)
}

func TestConcurrentCrossMovesCannotMakeACycle(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	for i := range 10 {
		a := addNode(t, st, u.ID, r.ID, KindFolder, fmt.Sprint("a", i))
		b := addNode(t, st, u.ID, r.ID, KindFolder, fmt.Sprint("b", i))
		var wg sync.WaitGroup
		errs := make([]error, 2)
		wg.Go(func() { _, errs[0] = st.MoveNode(ctx, a.ID, b.ID, nil, tag("x"), MoveGuard{}, t0) })
		wg.Go(func() { _, errs[1] = st.MoveNode(ctx, b.ID, a.ID, nil, tag("y"), MoveGuard{}, t0) })
		wg.Wait()
		if (errs[0] == nil) == (errs[1] == nil) {
			t.Fatalf("both or neither moved: %v, %v", errs[0], errs[1])
		}
	}
}

func TestTreeDepthIsCapped(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	parent := r.ID
	for i := 1; i <= MaxTreeDepth; i++ {
		parent = addNode(t, st, u.ID, parent, KindFolder, "d").ID
	}
	_, err := st.CreateNode(ctx, child(NewID(), u.ID, parent, KindFolder, "d"), nil)
	wantErr(t, err, ErrTreeTooDeep)

	// A shallow subtree cannot be moved past the limit either.
	a := addNode(t, st, u.ID, r.ID, KindFolder, "a")
	addNode(t, st, u.ID, a.ID, KindFolder, "b")
	_, err = st.MoveNode(ctx, a.ID, parent, nil, tag("x"), MoveGuard{}, t0)
	wantErr(t, err, ErrTreeTooDeep)

	// The deepest tree can still be cascaded away, with its owner.
	if _, err := st.DeleteUser(ctx, u.ID); err != nil {
		t.Errorf("delete the owner of the deepest tree: %v", err)
	}
}

func TestQuotaReservationAndRelease(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice") // quota 100
	r := root(t, st, u.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")

	up := func(size int64) Upload {
		return Upload{ID: NewID(), UserID: u.ID, NodeID: f.ID, VersionID: NewID(), Suite: suiteTest,
			FrameCount: 1, FrameSize: 1024, StoredSize: size, CreatedAt: t0}
	}
	first, err := st.CreateUpload(ctx, up(60))
	if err != nil {
		t.Fatal(err)
	}
	if got := usage(t, st, u.ID); got.ReservedBytes != 60 || got.UsedBytes != 0 {
		t.Errorf("after reserve: %+v", got)
	}
	_, err = st.CreateUpload(ctx, up(41))
	wantErr(t, err, ErrQuotaExceeded)
	second, err := st.CreateUpload(ctx, up(40))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteUpload(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	if got := usage(t, st, u.ID); got.ReservedBytes != 60 {
		t.Errorf("after abort: %+v", got)
	}
	if err := st.RecordFrame(ctx, first.ID, 0, tag("f"), t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CommitUpload(ctx, first.ID, CommitRequest{}, t0, placed); err != nil {
		t.Fatal(err)
	}
	if got := usage(t, st, u.ID); got.ReservedBytes != 0 || got.UsedBytes != 60 {
		t.Errorf("after commit: %+v", got)
	}
}

func TestQuotaZeroMeansNoLimit(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	if err := st.SetQuota(ctx, u.ID, 0); err != nil {
		t.Fatal(err)
	}
	r := root(t, st, u.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	commit(t, st, u.ID, f.ID, NewID(), 1<<40, nil)
	if got := usage(t, st, u.ID); got.UsedBytes != 1<<40 {
		t.Errorf("usage = %+v", got)
	}
}

func TestCommitRules(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	folder := addNode(t, st, u.ID, r.ID, KindFolder, "d")
	vid := NewID()

	_, err := st.CreateUpload(ctx, Upload{ID: NewID(), UserID: u.ID, NodeID: folder.ID, VersionID: NewID(), FrameCount: 1, CreatedAt: t0})
	wantErr(t, err, ErrNotFile)

	id := NewID()
	if _, err := st.CreateUpload(ctx, Upload{ID: id, UserID: u.ID, NodeID: f.ID, VersionID: vid, Suite: suiteTest,
		FrameCount: 2, FrameSize: 1024, StoredSize: 10, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	_, err = st.CreateUpload(ctx, Upload{ID: NewID(), UserID: u.ID, NodeID: f.ID, VersionID: vid, FrameCount: 1, CreatedAt: t0})
	wantErr(t, err, ErrIDTaken)

	if err := st.RecordFrame(ctx, id, 1, tag("b"), t0); err != nil {
		t.Fatal(err)
	}
	// A frame stays what it first was.
	if err := st.RecordFrame(ctx, id, 1, tag("b"), t0); err != nil {
		t.Errorf("a retry: %v", err)
	}
	wantErr(t, st.RecordFrame(ctx, id, 1, tag("c"), t0), ErrFrameConflict)
	wantErr(t, st.RecordFrame(ctx, NewID(), 1, tag("c"), t0), ErrNotFound)

	called := false
	_, err = st.CommitUpload(ctx, id, CommitRequest{}, t0, func(Upload) error { called = true; return nil })
	wantErr(t, err, ErrUploadIncomplete)
	if called {
		t.Error("placed an incomplete upload")
	}
	if err := st.RecordFrame(ctx, id, 0, tag("a"), t0); err != nil {
		t.Fatal(err)
	}

	wrong := "something else"
	_, err = st.CommitUpload(ctx, id, CommitRequest{Expected: &wrong}, t0, func(Upload) error { called = true; return nil })
	wantErr(t, err, ErrVersionConflict)
	if called {
		t.Error("placed despite a conflict")
	}

	// A failure to place undoes nothing and can be retried.
	boom := errors.New("boom")
	_, err = st.CommitUpload(ctx, id, CommitRequest{}, t0, func(Upload) error { return boom })
	wantErr(t, err, boom)
	if got := usage(t, st, u.ID); got.ReservedBytes != 10 || got.UsedBytes != 0 {
		t.Errorf("after a failed place: %+v", got)
	}

	none := ""
	v, err := st.CommitUpload(ctx, id, CommitRequest{Expected: &none, Signature: []byte("s"), Manifest: []byte("m")}, t0, placed)
	if err != nil {
		t.Fatal(err)
	}
	if v.ID != vid || v.ContentVersionID != vid || v.BlobID != id || v.AuthorID != u.ID ||
		!bytes.Equal(v.FrameHashes, append(tag("a"), tag("b")...)) || !bytes.Equal(v.Manifest, []byte("m")) {
		t.Errorf("version = %+v", v)
	}
	if n, _ := st.NodeByID(ctx, f.ID); n.CurrentVersion != vid {
		t.Errorf("current = %q", n.CurrentVersion)
	}
	_, err = st.UploadByID(ctx, id)
	wantErr(t, err, ErrNotFound)
	_, err = st.CommitUpload(ctx, id, CommitRequest{}, t0, placed)
	wantErr(t, err, ErrNotFound)

	// The id now belongs to a version, and the old expectation no longer holds.
	_, err = st.CreateUpload(ctx, Upload{ID: NewID(), UserID: u.ID, NodeID: f.ID, VersionID: vid, FrameCount: 1, CreatedAt: t0})
	wantErr(t, err, ErrIDTaken)
	second := NewID()
	if _, err := st.CreateUpload(ctx, Upload{ID: second, UserID: u.ID, NodeID: f.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 1, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordFrame(ctx, second, 0, tag("a"), t0); err != nil {
		t.Fatal(err)
	}
	_, err = st.CommitUpload(ctx, second, CommitRequest{Expected: &none}, t0, placed)
	wantErr(t, err, ErrVersionConflict)

	if _, err := st.TrashNode(ctx, f.ID, t0); err != nil {
		t.Fatal(err)
	}
	_, err = st.CommitUpload(ctx, second, CommitRequest{}, t0, placed)
	wantErr(t, err, ErrNodeTrashed)
	_, err = st.CreateUpload(ctx, Upload{ID: NewID(), UserID: u.ID, NodeID: f.ID, VersionID: NewID(), FrameCount: 1, CreatedAt: t0})
	wantErr(t, err, ErrNodeTrashed)
}

func TestRestoreAndDeleteVersions(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	v1 := commit(t, st, u.ID, f.ID, NewID(), 10, nil)
	v2 := commit(t, st, u.ID, f.ID, NewID(), 20, nil)
	if got := usage(t, st, u.ID); got.UsedBytes != 30 {
		t.Errorf("used = %d", got.UsedBytes)
	}

	stale := v1.ID
	_, err := st.RestoreVersion(ctx, f.ID, v1.ID, NewID(), u.ID, &stale, t0)
	wantErr(t, err, ErrVersionConflict)
	_, err = st.RestoreVersion(ctx, f.ID, NewID(), NewID(), u.ID, nil, t0)
	wantErr(t, err, ErrNotFound)
	_, err = st.RestoreVersion(ctx, f.ID, v1.ID, v2.ID, u.ID, nil, t0)
	wantErr(t, err, ErrIDTaken)

	current := v2.ID
	v3ID := NewID()
	v3, err := st.RestoreVersion(ctx, f.ID, v1.ID, v3ID, "editor", &current, t0)
	if err != nil {
		t.Fatal(err)
	}
	// The blob stays sealed and signed as v1, so what the client needs to open it
	// carries over, and only the new row knows who restored it.
	if v3.BlobID != v1.BlobID || v3.ContentVersionID != v1.ID || v3.ContentAuthorID != u.ID || v3.AuthorID != "editor" ||
		!bytes.Equal(v3.FrameHashes, v1.FrameHashes) || !bytes.Equal(v3.Manifest, v1.Manifest) {
		t.Errorf("restored = %+v", v3)
	}
	if got := usage(t, st, u.ID); got.UsedBytes != 30 {
		t.Errorf("restore should copy nothing: used %d", got.UsedBytes)
	}
	// A restore of a restore still names the original.
	v4, err := st.RestoreVersion(ctx, f.ID, v3.ID, NewID(), u.ID, nil, t0)
	if err != nil || v4.ContentVersionID != v1.ID {
		t.Errorf("second restore = %+v, %v", v4, err)
	}

	_, err = st.DeleteVersion(ctx, f.ID, v4.ID, t0, t0)
	wantErr(t, err, ErrVersionCurrent)

	// Marked versions keep their bytes and stay in the list.
	removeAt := t0.Add(time.Hour)
	if _, err := st.DeleteVersion(ctx, f.ID, v1.ID, t0, removeAt); err != nil {
		t.Fatal(err)
	}
	again, err := st.DeleteVersion(ctx, f.ID, v1.ID, t0, removeAt.Add(time.Hour))
	if err != nil || !again.RemoveAt.Equal(removeAt) {
		t.Errorf("the first mark should stand: %+v, %v", again.RemoveAt, err)
	}
	list, err := st.ListVersions(ctx, f.ID, 0, 2)
	if err != nil || len(list) != 2 || list[0].ID != v4.ID || len(list[0].FrameHashes) != 0 {
		t.Errorf("list = %+v, %v", list, err)
	}
	rest, err := st.ListVersions(ctx, f.ID, list[1].Seq, 10)
	if err != nil || len(rest) != 2 || rest[1].ID != v1.ID {
		t.Errorf("rest = %+v, %v", rest, err)
	}

	// The blob outlives the version while another version references it.
	if n, err := st.RemoveDueVersions(ctx, removeAt, 10); err != nil || n != 1 {
		t.Fatalf("remove: %d, %v", n, err)
	}
	if _, err := st.BlobByID(ctx, v1.BlobID); err != nil {
		t.Errorf("blob of restored version: %v", err)
	}
	if got := usage(t, st, u.ID); got.UsedBytes != 30 {
		t.Errorf("used = %d", got.UsedBytes)
	}
	for _, v := range []Version{v3} {
		if _, err := st.DeleteVersion(ctx, f.ID, v.ID, t0, removeAt); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.RemoveDueVersions(ctx, removeAt, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := st.BlobByID(ctx, v1.BlobID); err != nil {
		t.Errorf("v4 still references the blob: %v", err)
	}
}

func TestPurgeSweepAndRefcounts(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	folder := addNode(t, st, u.ID, r.ID, KindFolder, "d")
	f := addNode(t, st, u.ID, folder.ID, KindFile, "f")
	v := commit(t, st, u.ID, f.ID, NewID(), 10, nil)
	inflight := NewID()
	if _, err := st.CreateUpload(ctx, Upload{ID: inflight, UserID: u.ID, NodeID: f.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 5, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}

	_, err := st.PurgeNode(ctx, folder.ID, t0, t0)
	wantErr(t, err, ErrNotTrashed)
	if _, err := st.TrashNode(ctx, folder.ID, t0); err != nil {
		t.Fatal(err)
	}
	removeAt := t0.Add(time.Hour)
	if n, err := st.PurgeNode(ctx, folder.ID, t0, removeAt); err != nil || !n.RemoveAt.Equal(removeAt) || n.PurgedAt.IsZero() {
		t.Fatalf("purge = %+v, %v", n, err)
	}
	if n, err := st.PurgeNode(ctx, folder.ID, t0, removeAt.Add(time.Hour)); err != nil || !n.RemoveAt.Equal(removeAt) {
		t.Errorf("second purge moved the time: %+v, %v", n.RemoveAt, err)
	}

	// Before its time nothing goes, and quota still counts it.
	if n, err := st.RemoveDueNodes(ctx, removeAt.Add(-time.Second), 10); err != nil || n != 0 {
		t.Errorf("early removal: %d, %v", n, err)
	}
	if got := usage(t, st, u.ID); got.UsedBytes != 10 || got.ReservedBytes != 5 {
		t.Errorf("usage = %+v", got)
	}

	if n, err := st.RemoveDueNodes(ctx, removeAt, 10); err != nil || n != 1 {
		t.Fatalf("removal: %d, %v", n, err)
	}
	if _, err := st.NodeByID(ctx, f.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("child should go with its folder: %v", err)
	}
	if got := usage(t, st, u.ID); got.UsedBytes != 0 || got.ReservedBytes != 0 {
		t.Errorf("usage after removal = %+v", got)
	}
	pending, err := st.PendingFileRemovals(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(pending, FileRemoval{RemoveBlob, v.BlobID}) || !slices.Contains(pending, FileRemoval{RemoveUpload, inflight}) {
		t.Errorf("pending = %+v", pending)
	}
	if err := st.ClearFileRemoval(ctx, pending[0]); err != nil {
		t.Fatal(err)
	}
	if after, _ := st.PendingFileRemovals(ctx, 10); len(after) != len(pending)-1 {
		t.Errorf("after clearing: %+v", after)
	}
}

func TestRestoreCancelsAPurge(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	if _, err := st.TrashNode(ctx, f.ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PurgeNode(ctx, f.ID, t0, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	got, err := st.RestoreNode(ctx, f.ID, t0)
	if err != nil || !got.PurgedAt.IsZero() || !got.RemoveAt.IsZero() || !got.TrashedAt.IsZero() {
		t.Fatalf("restore = %+v, %v", got, err)
	}
	if n, err := st.RemoveDueNodes(ctx, t0.Add(2*time.Hour), 10); err != nil || n != 0 {
		t.Errorf("removed a restored node: %d, %v", n, err)
	}
	_, err = st.RestoreNode(ctx, f.ID, t0)
	wantErr(t, err, ErrNotTrashed)
}

func TestRestoreUnderTrashedParentIsRefused(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	d := addNode(t, st, u.ID, r.ID, KindFolder, "d")
	f := addNode(t, st, u.ID, d.ID, KindFile, "f")
	if _, err := st.TrashNode(ctx, f.ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.TrashNode(ctx, d.ID, t0); err != nil {
		t.Fatal(err)
	}
	_, err := st.RestoreNode(ctx, f.ID, t0)
	wantErr(t, err, ErrParentTrashed)
}

func TestEmptyTrashAndRetention(t *testing.T) {
	st := open(t)
	u, other := addUser(t, st, "alice"), addUser(t, st, "bob")
	r, otherRoot := root(t, st, u.ID), root(t, st, other.ID)
	a := addNode(t, st, u.ID, r.ID, KindFile, "a")
	b := addNode(t, st, u.ID, r.ID, KindFile, "b")
	keep := addNode(t, st, other.ID, otherRoot.ID, KindFile, "c")
	for _, n := range []Node{a, keep} {
		if _, err := st.TrashNode(ctx, n.ID, t0); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.TrashNode(ctx, b.ID, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n, err := st.EmptyTrash(ctx, u.ID, t0, t0.Add(time.Minute)); err != nil || n != 2 {
		t.Errorf("empty = %d, %v", n, err)
	}
	if n, _ := st.NodeByID(ctx, keep.ID); !n.PurgedAt.IsZero() {
		t.Error("emptying one user's trash touched another's")
	}
	// Only what has been in the trash long enough is marked.
	if n, err := st.MarkExpiredTrash(ctx, t0, t0, t0); err != nil || n != 0 {
		t.Errorf("mark at the edge = %d, %v", n, err)
	}
	if n, err := st.MarkExpiredTrash(ctx, t0.Add(time.Second), t0, t0.Add(time.Minute)); err != nil || n != 1 {
		t.Errorf("mark = %d, %v", n, err)
	}
}

func TestStaleUploadsAreRemoved(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	id := NewID()
	if _, err := st.CreateUpload(ctx, Upload{ID: id, UserID: u.ID, NodeID: f.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 5, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	// A frame counts as activity.
	if err := st.RecordFrame(ctx, id, 0, tag("f"), t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n, err := st.RemoveStaleUploads(ctx, t0.Add(time.Minute), 10); err != nil || n != 0 {
		t.Errorf("removed an active upload: %d, %v", n, err)
	}
	if n, err := st.RemoveStaleUploads(ctx, t0.Add(2*time.Hour), 10); err != nil || n != 1 {
		t.Errorf("remove = %d, %v", n, err)
	}
	if got := usage(t, st, u.ID); got.ReservedBytes != 0 {
		t.Errorf("usage = %+v", got)
	}
}

func TestSmallBlobs(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	place := func() error { return nil }

	thumb := Blob{ID: NewID(), OwnerID: u.ID, NodeID: f.ID, Kind: BlobThumb, Suite: suiteTest, Size: 90, CreatedAt: t0}
	if err := st.PutSmallBlob(ctx, thumb, place); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.NodeByID(ctx, f.ID); n.ThumbBlobID != thumb.ID {
		t.Errorf("thumb = %q", n.ThumbBlobID)
	}
	wantErr(t, st.PutSmallBlob(ctx, thumb, place), ErrIDTaken)

	// A replacement counts net of what it replaces.
	next := thumb
	next.ID, next.Size = NewID(), 100
	if err := st.PutSmallBlob(ctx, next, place); err != nil {
		t.Fatalf("replace: %v", err)
	}
	if n, _ := st.NodeByID(ctx, f.ID); n.ThumbBlobID != next.ID {
		t.Errorf("thumb = %q", n.ThumbBlobID)
	}
	if got := usage(t, st, u.ID); got.UsedBytes != 100 {
		t.Errorf("used = %d", got.UsedBytes)
	}

	// The id of a removed file waits until its file is gone.
	wantErr(t, st.PutSmallBlob(ctx, Blob{ID: thumb.ID, OwnerID: u.ID, Kind: BlobIndex, Suite: suiteTest, Size: 0, CreatedAt: t0}, place), ErrIDTaken)

	idx := Blob{ID: NewID(), OwnerID: u.ID, Kind: BlobIndex, Suite: suiteTest, Size: 1, CreatedAt: t0}
	wantErr(t, st.PutSmallBlob(ctx, idx, place), ErrQuotaExceeded)
	if err := st.SetQuota(ctx, u.ID, 101); err != nil {
		t.Fatal(err)
	}
	if err := st.PutSmallBlob(ctx, idx, place); err != nil {
		t.Fatal(err)
	}
	list, err := st.ListIndexBlobs(ctx, u.ID, "", 10)
	if err != nil || len(list) != 1 || list[0].ID != idx.ID || list[0].NodeID != "" {
		t.Errorf("index = %+v, %v", list, err)
	}

	// A refused replacement keeps the old one.
	big := thumb
	big.ID, big.Size = NewID(), 101
	wantErr(t, st.PutSmallBlob(ctx, big, place), ErrQuotaExceeded)
	if n, _ := st.NodeByID(ctx, f.ID); n.ThumbBlobID != next.ID {
		t.Errorf("thumb after refusal = %q", n.ThumbBlobID)
	}

	if err := st.DeleteSmallBlob(ctx, idx.ID, t0); err != nil {
		t.Fatal(err)
	}
	if got := usage(t, st, u.ID); got.UsedBytes != 100 {
		t.Errorf("used = %d", got.UsedBytes)
	}
	v := commit(t, st, u.ID, f.ID, NewID(), 1, nil)
	wantErr(t, st.DeleteSmallBlob(ctx, v.BlobID, t0), ErrBlobKept)
	wantErr(t, st.DeleteSmallBlob(ctx, NewID(), t0), ErrNotFound)
}

func TestChangesAreScopedOrderedAndSurviveRemoval(t *testing.T) {
	st := open(t)
	u, other := addUser(t, st, "alice"), addUser(t, st, "bob")
	r, otherRoot := root(t, st, u.ID), root(t, st, other.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	addNode(t, st, other.ID, otherRoot.ID, KindFile, "g")
	commit(t, st, u.ID, f.ID, NewID(), 1, nil)
	if _, err := st.TrashNode(ctx, f.ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PurgeNode(ctx, f.ID, t0, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RemoveDueNodes(ctx, t0, 10); err != nil {
		t.Fatal(err)
	}
	wantOps := []string{OpCreated, OpCreated, OpVersion, OpTrashed, OpPurged, OpRemoved}
	var got []string
	after := int64(0)
	for {
		page, err := st.ListChanges(ctx, u.ID, after, 2)
		if err != nil {
			t.Fatal(err)
		}
		if len(page) == 0 {
			break
		}
		for _, c := range page {
			if c.Seq <= after {
				t.Errorf("sequence went back: %d after %d", c.Seq, after)
			}
			after = c.Seq
			got = append(got, c.Op)
		}
	}
	if fmt.Sprint(got) != fmt.Sprint(wantOps) {
		t.Errorf("ops = %v, want %v", got, wantOps)
	}
}

func TestDeletingAUserQueuesEverything(t *testing.T) {
	st := open(t)
	u, other := addUser(t, st, "alice"), addUser(t, st, "bob")
	r := root(t, st, u.ID)
	d := addNode(t, st, u.ID, r.ID, KindFolder, "d")
	f := addNode(t, st, u.ID, d.ID, KindFile, "f")
	v := commit(t, st, u.ID, f.ID, NewID(), 1, nil)
	if _, err := st.RestoreVersion(ctx, f.ID, v.ID, NewID(), u.ID, nil, t0); err != nil {
		t.Fatal(err)
	}
	thumb := Blob{ID: NewID(), OwnerID: u.ID, NodeID: f.ID, Kind: BlobThumb, Suite: suiteTest, Size: 1, CreatedAt: t0}
	if err := st.PutSmallBlob(ctx, thumb, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	idx := Blob{ID: NewID(), OwnerID: u.ID, Kind: BlobIndex, Suite: suiteTest, Size: 1, CreatedAt: t0}
	if err := st.PutSmallBlob(ctx, idx, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	up := NewID()
	if _, err := st.CreateUpload(ctx, Upload{ID: up, UserID: u.ID, NodeID: f.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 1, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DeleteUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	pending, err := st.PendingFileRemovals(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := map[FileRemoval]bool{}
	for _, p := range pending {
		found[p] = true
	}
	for _, want := range []FileRemoval{{RemoveBlob, v.BlobID}, {RemoveBlob, thumb.ID}, {RemoveBlob, idx.ID}, {RemoveUpload, up}} {
		if !found[want] {
			t.Errorf("missing %+v in %+v", want, pending)
		}
	}
	if _, err := st.NodeByID(ctx, f.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("node survived: %v", err)
	}
	if got := usage(t, st, other.ID); got.UsedBytes != 0 {
		t.Errorf("other's usage = %+v", got)
	}
}

func TestStats(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	f := addNode(t, st, u.ID, r.ID, KindFile, "f")
	commit(t, st, u.ID, f.ID, NewID(), 7, nil)
	if _, err := st.CreateUpload(ctx, Upload{ID: NewID(), UserID: u.ID, NodeID: f.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 3, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	got, err := st.Stats(ctx)
	if err != nil || got.Blobs != 1 || got.StoredBytes != 7 || got.Uploads != 1 || got.ReservedBytes != 3 {
		t.Errorf("stats = %+v, %v", got, err)
	}
}

func TestShardQueryCoversTheShardOnly(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	for _, id := range []string{"ab" + NewID()[2:], "abff" + NewID()[4:], "ac" + NewID()[2:]} {
		if err := st.PutSmallBlob(ctx, Blob{ID: id, OwnerID: u.ID, Kind: BlobIndex, Suite: suiteTest, Size: 0, CreatedAt: t0}, func() error { return nil }); err != nil {
			t.Fatal(err)
		}
	}
	got, err := st.BlobIDsInShard(ctx, "ab")
	if err != nil || len(got) != 2 {
		t.Errorf("shard = %v, %v", got, err)
	}
}

func TestLiveSnapshotBesideAnOpenStore(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.CompleteSetup(ctx, settings(), user("root")); err != nil {
		t.Fatal(err)
	}
	u := addUser(t, st, "alice")
	idx := Blob{ID: NewID(), OwnerID: u.ID, Kind: BlobIndex, Suite: suiteTest, Size: 1, CreatedAt: t0}
	if err := st.PutSmallBlob(ctx, idx, func() error { return nil }); err != nil {
		t.Fatal(err)
	}

	// Store.Open would refuse here: the store holds the lock.
	live, err := OpenLive(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = live.Close() }()
	dest := t.TempDir()
	if err := live.Snapshot(ctx, dest); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(filepath.Join(dest, dbFile+snapshotSuffix)); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("snapshot = %v, %v", info, err)
	}
	if _, err := os.Stat(filepath.Join(dest, dbFile)); err == nil {
		t.Error("the snapshot has its final name too early")
	}
	if err := live.RecordBackup(ctx, t0); err != nil {
		t.Fatal(err)
	}
	got, err := st.Settings(ctx)
	if err != nil || !got.LastBackupAt.Equal(t0) {
		t.Errorf("settings = %+v, %v", got, err)
	}

	snap, err := OpenSnapshot(dest)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := snap.BlobIDs(ctx)
	if err != nil || len(ids) != 1 || ids[0] != idx.ID {
		t.Errorf("ids = %v, %v", ids, err)
	}
	if err := snap.Close(); err != nil {
		t.Fatal(err)
	}
	if err := FinishSnapshot(dest); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenLive(dest); err != nil {
		t.Errorf("the finished backup: %v", err)
	}
}

func TestOpenLiveRefuses(t *testing.T) {
	if _, err := OpenLive(t.TempDir()); err == nil {
		t.Error("opened a directory with no database")
	}
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.write.ExecContext(ctx, "PRAGMA user_version = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenLive(dir); !errors.Is(err, ErrSchemaTooOld) {
		t.Errorf("old schema: %v", err)
	}
	if _, err := st.write.ExecContext(ctx, "PRAGMA user_version = 99"); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenLive(dir); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("new schema: %v", err)
	}
	if _, err := st.write.ExecContext(ctx, "PRAGMA user_version = 2"); err != nil {
		t.Fatal(err)
	}
	_ = st.Close()
}

func TestARelativeDataDirectoryWorks(t *testing.T) {
	t.Chdir(t.TempDir())
	st, err := Open("data")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if _, err := st.ServerSecret(ctx); err != nil {
		t.Errorf("write: %v", err)
	}
	live, err := OpenLive("data")
	if err != nil {
		t.Fatal(err)
	}
	if err := live.Close(); err != nil {
		t.Error(err)
	}
}

func TestSealedMetadataCountsAgainstTheQuota(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice") // quota 100
	r := root(t, st, u.ID)
	sized := func(n int) Node {
		c := child(NewID(), u.ID, r.ID, KindFolder, fmt.Sprint("n", n, NewID()))
		c.SealedMetadata = make([]byte, n)
		return c
	}
	used := func() int64 { return usage(t, st, u.ID).UsedBytes }

	a, err := st.CreateNode(ctx, sized(60), nil)
	if err != nil {
		t.Fatal(err)
	}
	if used() != 60 {
		t.Errorf("after create: used %d", used())
	}
	_, err = st.CreateNode(ctx, sized(41), nil)
	wantErr(t, err, ErrQuotaExceeded)
	if used() != 60 {
		t.Errorf("after a refusal: used %d", used())
	}

	// A rename that grows it is checked, one that shrinks it frees the difference.
	_, err = st.UpdateNode(ctx, a.ID, make([]byte, 101), nil, KeyCheck{}, t0)
	wantErr(t, err, ErrQuotaExceeded)
	if _, err := st.UpdateNode(ctx, a.ID, make([]byte, 30), nil, KeyCheck{}, t0); err != nil {
		t.Fatal(err)
	}
	if used() != 30 {
		t.Errorf("after shrinking: used %d", used())
	}
	_, err = st.RotateNode(ctx, a.ID, Rotation{KeyGeneration: 1, ParentKeyGeneration: 1, SealedMetadata: make([]byte, 101)}, t0)
	wantErr(t, err, ErrQuotaExceeded)
	if _, err := st.RotateNode(ctx, a.ID, Rotation{KeyGeneration: 1, ParentKeyGeneration: 1, SealedMetadata: make([]byte, 50)}, t0); err != nil {
		t.Fatal(err)
	}
	if used() != 50 {
		t.Errorf("after rotating: used %d", used())
	}

	// It goes with the node, with the subtree of a removed one too.
	sub, err := st.CreateNode(ctx, sized(10), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateNode(ctx, child(NewID(), u.ID, sub.ID, KindFile, "deep"), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := st.TrashNode(ctx, a.ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PurgeNode(ctx, a.ID, t0, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RemoveDueNodes(ctx, t0.Add(time.Hour), 10); err != nil {
		t.Fatal(err)
	}
	if used() != 10 {
		t.Errorf("after removal: used %d", used())
	}
}

func TestTheMigrationChargesNodesThatAreThere(t *testing.T) {
	dir := t.TempDir()
	// A database from before the charge, with 7 bytes of blobs and two nodes, written
	// as that release wrote them.
	db, err := sql.Open("sqlite", dsn(filepath.Join(dir, dbFile), "_pragma=journal_mode(WAL)"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if err := migrateTo(ctx, db, 3); err != nil {
		t.Fatal(err)
	}
	u := NewID()
	exec(t, db, `INSERT INTO users (id, username, role, kdf, used_bytes, created_at) VALUES (?, 'alice', 'user', ?, 7, ?)`,
		u, []byte(`{"name":"argon2id"}`), t0.Unix())
	rootID := NewID()
	node := `INSERT INTO nodes (id, owner_id, parent_id, kind, suite, sealed_metadata, wrapped_key, name_tag, created_at, updated_at)
		VALUES (?, ?, ?, 'folder', ?, ?, ?, ?, ?, ?)`
	exec(t, db, node, rootID, u, nil, suiteTest, []byte{}, []byte{}, nil, t0.Unix(), t0.Unix())
	for i, size := range []int{20, 5} {
		exec(t, db, node, NewID(), u, rootID, suiteTest, make([]byte, size), []byte{}, tag(fmt.Sprint("n", i)), t0.Unix(), t0.Unix())
	}
	_ = db.Close()

	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if got := usage(t, st, u).UsedBytes; got != 7+25 {
		t.Errorf("used %d, want 32", got)
	}
}

// A copy of the database must not carry the server secret: it signs link
// tokens, so a backup that kept it could sign one for any live link, password
// or not. Neither the snapshot nor a database restored from an older backup
// that has it may hold its bytes anywhere in the file.
func TestCopiesForgetTheServerSecret(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.CompleteSetup(ctx, settings(), user("root")); err != nil {
		t.Fatal(err)
	}
	secret, err := st.ServerSecret(ctx)
	if err != nil {
		t.Fatal(err)
	}
	needle := []byte(hex.EncodeToString(secret))
	holds := func(path string) bool {
		t.Helper()
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return bytes.Contains(b, needle)
	}

	live, err := OpenLive(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = live.Close() }()
	backup := t.TempDir()
	if err := live.Snapshot(ctx, backup); err != nil {
		t.Fatal(err)
	}
	if err := FinishSnapshot(backup); err != nil {
		t.Fatal(err)
	}
	if holds(filepath.Join(backup, dbFile)) {
		t.Error("the snapshot holds the server secret")
	}
	if got, err := st.ServerSecret(ctx); err != nil || !bytes.Equal(got, secret) {
		t.Errorf("the live secret changed: %v", err)
	}

	// A backup from before: the file as it was, secret included.
	old := t.TempDir()
	if _, err := st.write.ExecContext(ctx, "VACUUM INTO ?", filepath.Join(old, dbFile)); err != nil {
		t.Fatal(err)
	}
	if !holds(filepath.Join(old, dbFile)) {
		t.Fatal("the plain copy has no secret to forget")
	}
	restored := t.TempDir()
	if err := RestoreDatabase(ctx, old, restored); err != nil {
		t.Fatal(err)
	}
	if holds(filepath.Join(restored, dbFile)) {
		t.Error("the restored database holds the old server secret")
	}
	again, err := Open(restored)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = again.Close() }()
	fresh, err := again.ServerSecret(ctx)
	if err != nil || len(fresh) != serverSecretLen || bytes.Equal(fresh, secret) {
		t.Errorf("restored server secret = %x, %v", fresh, err)
	}
	if _, err := again.Settings(ctx); err != nil {
		t.Errorf("restored settings: %v", err)
	}
}

// A copy of the database is 0600 from the moment it exists, whatever the umask:
// made under the umask and chmod'd after, it could be read in between.
func TestCopiesAreNeverReadableByOthers(t *testing.T) {
	old := syscall.Umask(0)
	defer syscall.Umask(old)
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.CompleteSetup(ctx, settings(), user("root")); err != nil {
		t.Fatal(err)
	}
	// The mode is watched for as long as the snapshot takes.
	backup := t.TempDir()
	tmp := filepath.Join(backup, dbFile+snapshotSuffix)
	var seen []os.FileMode
	var mu sync.Mutex
	var stop atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		for !stop.Load() {
			if info, err := os.Stat(tmp); err == nil {
				mu.Lock()
				seen = append(seen, info.Mode().Perm())
				mu.Unlock()
			}
		}
	}()
	live, err := OpenLive(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = live.Close() }()
	if err := live.Snapshot(ctx, backup); err != nil {
		t.Fatal(err)
	}
	stop.Store(true)
	<-done
	info, err := os.Stat(tmp)
	if err != nil {
		t.Fatal(err)
	}
	seen = append(seen, info.Mode().Perm())
	for _, m := range seen {
		if m != 0o600 {
			t.Fatalf("the snapshot was %o at some point", m)
		}
	}
}
