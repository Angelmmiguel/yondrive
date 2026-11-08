package store

import (
	"testing"
	"time"
)

func addRequest(t *testing.T, st *Store, owner, folder string, l Link) Link {
	t.Helper()
	l.ID, l.NodeID, l.OwnerID, l.Kind, l.KeyGeneration, l.PublicKey, l.CreatedAt = NewID(), folder, owner, LinkKindRequest, 1, []byte{}, t0
	out, err := st.CreateLink(ctx, l)
	if err != nil {
		t.Fatalf("CreateLink: %v", err)
	}
	return out
}

func item(size int64) Incoming {
	return Incoming{ID: NewID(), BlobID: NewID(), VersionID: NewID(), Suite: suiteTest, SealedMetadata: []byte("{}"),
		Size: size, StoredSize: size, FrameCount: 1, FrameSize: 1024, CreatedAt: t0}
}

// arrive sends one file through a request, all the way to an incoming item.
func arrive(t *testing.T, st *Store, linkID string, size int64) Incoming {
	t.Helper()
	in := item(size)
	if _, err := st.CreateRequestUpload(ctx, linkID, in); err != nil {
		t.Fatalf("CreateRequestUpload: %v", err)
	}
	if err := st.RecordFrame(ctx, in.BlobID, 0, tag("f"), t0); err != nil {
		t.Fatal(err)
	}
	if err := st.CommitRequestUpload(ctx, in.BlobID, nil, []byte("{}"), t0, placed); err != nil {
		t.Fatalf("CommitRequestUpload: %v", err)
	}
	return in
}

func TestARequestTakesFilesUpToItsLimits(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	folder := addNode(t, st, u.ID, r.ID, KindFolder, "inbox")
	file := addNode(t, st, u.ID, r.ID, KindFile, "file")

	if _, err := st.CreateLink(ctx, Link{ID: NewID(), NodeID: file.ID, OwnerID: u.ID, Kind: LinkKindRequest,
		KeyGeneration: 1, PublicKey: []byte{}, CreatedAt: t0}); err == nil {
		t.Error("a request into a file")
	}
	l := addRequest(t, st, u.ID, folder.ID, Link{MaxFileSize: 10, FileLimit: 3, BytesLimit: 25})

	_, err := st.CreateRequestUpload(ctx, l.ID, item(11))
	wantErr(t, err, ErrRequestFileTooLarge)
	first := item(10)
	if _, err := st.CreateRequestUpload(ctx, l.ID, first); err != nil {
		t.Fatal(err)
	}
	if got := usage(t, st, u.ID).ReservedBytes; got != 10 {
		t.Errorf("reserved %d, want 10", got)
	}
	again := item(1)
	again.ID = first.ID
	_, err = st.CreateRequestUpload(ctx, l.ID, again)
	wantErr(t, err, ErrIDTaken)
	again = item(1)
	again.ID = folder.ID
	_, err = st.CreateRequestUpload(ctx, l.ID, again)
	wantErr(t, err, ErrIDTaken)
	arrive(t, st, l.ID, 10)
	_, err = st.CreateRequestUpload(ctx, l.ID, item(10))
	wantErr(t, err, ErrRequestBytes)

	// An upload that never finishes gives its room back.
	if err := st.DeleteUpload(ctx, first.BlobID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.IncomingByID(ctx, first.ID); err == nil {
		t.Error("the item of an aborted upload is still there")
	}
	if got, _ := st.LinkByID(ctx, l.ID); got.FilesReceived != 1 || got.BytesReceived != 10 {
		t.Errorf("received %d files, %d bytes", got.FilesReceived, got.BytesReceived)
	}
	arrive(t, st, l.ID, 5)
	arrive(t, st, l.ID, 5)
	_, err = st.CreateRequestUpload(ctx, l.ID, item(1))
	wantErr(t, err, ErrRequestFiles)

	// The owner's quota holds on top.
	other := addRequest(t, st, u.ID, folder.ID, Link{})
	_, err = st.CreateRequestUpload(ctx, other.ID, item(200))
	wantErr(t, err, ErrQuotaExceeded)

	// A view link is not a request.
	view := addLink(t, st, u.ID, folder.ID, 0)
	_, err = st.CreateRequestUpload(ctx, view.ID, item(1))
	wantErr(t, err, ErrNotFound)
}

func TestARequestUploadStaysOffTheOwnersUploads(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	folder := addNode(t, st, u.ID, r.ID, KindFolder, "inbox")
	l := addRequest(t, st, u.ID, folder.ID, Link{})
	in := item(10)
	if _, err := st.CreateRequestUpload(ctx, l.ID, in); err != nil {
		t.Fatal(err)
	}
	if list, err := st.ListUploads(ctx, u.ID, "", 10); err != nil || len(list) != 0 {
		t.Errorf("owner's uploads = %+v, %v", list, err)
	}
	if err := st.RecordFrame(ctx, in.BlobID, 0, tag("f"), t0); err != nil {
		t.Fatal(err)
	}
	_, err := st.CommitUpload(ctx, in.BlobID, CommitRequest{Manifest: []byte("m")}, t0, placed)
	wantErr(t, err, ErrNotFound)
	if items, _ := st.ListIncoming(ctx, u.ID, "", 10); len(items) != 0 {
		t.Errorf("an item on its way is listed: %+v", items)
	}
}

func TestAdoptingPutsTheFileInTheFolder(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	folder := addNode(t, st, u.ID, r.ID, KindFolder, "inbox")
	addNode(t, st, u.ID, folder.ID, KindFile, "taken")
	l := addRequest(t, st, u.ID, folder.ID, Link{})
	in := arrive(t, st, l.ID, 30)
	if got := usage(t, st, u.ID); got.UsedBytes != 30 || got.ReservedBytes != 0 {
		t.Errorf("usage %+v after arriving", got)
	}
	items, err := st.ListIncoming(ctx, u.ID, "", 10)
	if err != nil || len(items) != 1 || items[0].ID != in.ID || len(items[0].FrameHashes) != 32 {
		t.Fatalf("incoming = %+v, %v", items, err)
	}

	gen := int64(1)
	adoption := Adoption{ParentGeneration: &gen, NameTag: tag("taken"), SealedMetadata: []byte("{}"), Manifest: []byte("m")}
	_, _, err = st.AdoptIncoming(ctx, in.ID, adoption, t0)
	wantErr(t, err, ErrNameConflict)
	stale := int64(2)
	adoption.NameTag, adoption.ParentGeneration = tag("new"), &stale
	_, _, err = st.AdoptIncoming(ctx, in.ID, adoption, t0)
	wantErr(t, err, ErrKeyGeneration)
	adoption.ParentGeneration = &gen
	n, v, err := st.AdoptIncoming(ctx, in.ID, adoption, t0)
	if err != nil {
		t.Fatal(err)
	}
	if n.ID != in.ID || n.ParentID != folder.ID || n.CurrentVersion != in.VersionID || v.BlobID != in.BlobID || v.AuthorID != u.ID {
		t.Errorf("adopted %+v, %+v", n, v)
	}
	if b, err := st.BlobByID(ctx, in.BlobID); err != nil || b.NodeID != in.ID {
		t.Errorf("blob = %+v, %v", b, err)
	}
	if got := usage(t, st, u.ID).UsedBytes; got != 32 {
		t.Errorf("used %d, want the blob and the metadata", got)
	}
	_, _, err = st.AdoptIncoming(ctx, in.ID, adoption, t0)
	wantErr(t, err, ErrNotFound)
}

func TestIncomingGoesWithItsRequest(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	folder := addNode(t, st, u.ID, r.ID, KindFolder, "inbox")

	deleted := addRequest(t, st, u.ID, folder.ID, Link{})
	gone := arrive(t, st, deleted.ID, 10)
	if err := st.DeleteIncoming(ctx, gone.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.BlobByID(ctx, gone.BlobID); err == nil {
		t.Error("a deleted item kept its blob")
	}
	if got, _ := st.LinkByID(ctx, deleted.ID); got.FilesReceived != 1 {
		t.Errorf("a deleted item gave back its place: %d", got.FilesReceived)
	}
	arrive(t, st, deleted.ID, 10)
	if err := st.DeleteLink(ctx, deleted.ID); err != nil {
		t.Fatal(err)
	}

	ended := addRequest(t, st, u.ID, folder.ID, Link{ExpiresAt: t0.Add(time.Hour)})
	arrive(t, st, ended.ID, 10)
	revoked := addRequest(t, st, u.ID, folder.ID, Link{})
	arrive(t, st, revoked.ID, 10)
	if _, err := st.RevokeLink(ctx, revoked.ID, t0.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	live := addRequest(t, st, u.ID, folder.ID, Link{})
	kept := arrive(t, st, live.ID, 10)

	if n, err := st.RemoveEndedIncoming(ctx, t0.Add(time.Hour), 10); err != nil || n != 0 {
		t.Errorf("removed %d at the end, %v", n, err)
	}
	if n, err := st.RemoveEndedIncoming(ctx, t0.Add(3*time.Hour), 10); err != nil || n != 2 {
		t.Errorf("removed %d after the grace, %v", n, err)
	}
	items, err := st.ListIncoming(ctx, u.ID, "", 10)
	if err != nil || len(items) != 1 || items[0].ID != kept.ID {
		t.Errorf("left = %+v, %v", items, err)
	}
	if got := usage(t, st, u.ID); got.UsedBytes != 10 || got.ReservedBytes != 0 {
		t.Errorf("usage %+v, want the one item left", got)
	}

	// Purging the folder takes the request and what waits in it.
	if _, err := st.TrashNode(ctx, folder.ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PurgeNode(ctx, folder.ID, t0, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RemoveDueNodes(ctx, t0.Add(time.Hour), 10); err != nil {
		t.Fatal(err)
	}
	if items, _ := st.ListIncoming(ctx, u.ID, "", 10); len(items) != 0 {
		t.Errorf("items outlived their folder: %+v", items)
	}
	if got := usage(t, st, u.ID).UsedBytes; got != 0 {
		t.Errorf("used %d after the purge", got)
	}
}

func TestAnIdleRequestUploadGivesItsPlaceBack(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	folder := addNode(t, st, u.ID, r.ID, KindFolder, "inbox")
	l := addRequest(t, st, u.ID, folder.ID, Link{FileLimit: 1})
	in := item(10)
	if _, err := st.CreateRequestUpload(ctx, l.ID, in); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.LinkByID(ctx, l.ID); got.UploadsInProgress != 1 || got.FilesReceived != 1 {
		t.Errorf("link %+v", got)
	}
	_, err := st.CreateRequestUpload(ctx, l.ID, item(1))
	wantErr(t, err, ErrRequestFiles)

	// An account's upload of the same age stays.
	own := addNode(t, st, u.ID, r.ID, KindFile, "own")
	if _, err := st.CreateUpload(ctx, Upload{ID: NewID(), UserID: u.ID, NodeID: own.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 5, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	if n, err := st.RemoveIdleRequestUploads(ctx, t0, 10); err != nil || n != 0 {
		t.Errorf("removed %d before it was idle, %v", n, err)
	}
	if n, err := st.RemoveIdleRequestUploads(ctx, t0.Add(time.Second), 10); err != nil || n != 1 {
		t.Errorf("removed %d, %v", n, err)
	}
	if got, _ := st.LinkByID(ctx, l.ID); got.UploadsInProgress != 0 || got.FilesReceived != 0 {
		t.Errorf("link after the sweep %+v", got)
	}
	if got := usage(t, st, u.ID).ReservedBytes; got != 5 {
		t.Errorf("reserved %d, want the account's upload alone", got)
	}
	if _, err := st.IncomingByBlob(ctx, in.BlobID); err == nil {
		t.Error("the item of an idle upload is still there")
	}
}
