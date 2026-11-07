package store

import (
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func addGrant(t *testing.T, st *Store, owner, grantee, node, role string) Grant {
	t.Helper()
	g, err := st.CreateGrant(ctx, Grant{ID: NewID(), NodeID: node, GranteeID: grantee, GranterID: owner, Role: role,
		KeyGeneration: 1, CreatedAt: t0})
	if err != nil {
		t.Fatalf("CreateGrant: %v", err)
	}
	return g
}

// journal returns "node:op" for each entry of a user's journal.
func journal(t *testing.T, st *Store, user string) []string {
	t.Helper()
	changes, err := st.ListChanges(ctx, user, 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(changes))
	for _, c := range changes {
		out = append(out, c.NodeID+":"+c.Op)
	}
	return out
}

func wantJournal(t *testing.T, st *Store, user, node, op string) {
	t.Helper()
	if got := journal(t, st, user); !slices.Contains(got, node+":"+op) {
		t.Errorf("%s has no %s %s in %v", user, node, op, got)
	}
}

func TestGrantRefusals(t *testing.T) {
	st := open(t)
	owner, bob := addUser(t, st, "owner"), addUser(t, st, "bob")
	r := root(t, st, owner.ID)
	f := addNode(t, st, owner.ID, r.ID, KindFolder, "f")

	base := Grant{NodeID: f.ID, GranteeID: bob.ID, GranterID: owner.ID, Role: RoleViewer, KeyGeneration: 1, CreatedAt: t0}
	on := func(mod func(*Grant)) error {
		g := base
		g.ID = NewID()
		mod(&g)
		_, err := st.CreateGrant(ctx, g)
		return err
	}
	wantErr(t, on(func(g *Grant) { g.NodeID = r.ID }), ErrRootImmutable)
	wantErr(t, on(func(g *Grant) { g.NodeID = NewID() }), ErrNotFound)
	wantErr(t, on(func(g *Grant) { g.KeyGeneration = 2 }), ErrKeyGeneration)
	if err := on(func(*Grant) {}); err != nil {
		t.Fatal(err)
	}
	wantErr(t, on(func(*Grant) {}), ErrGrantExists)

	trashed := addNode(t, st, owner.ID, f.ID, KindFile, "t")
	if _, err := st.TrashNode(ctx, f.ID, t0); err != nil {
		t.Fatal(err)
	}
	wantErr(t, on(func(g *Grant) { g.NodeID = trashed.ID }), ErrNodeTrashed)
}

func TestLineageRolesFollowMoves(t *testing.T) {
	st := open(t)
	owner, bob := addUser(t, st, "owner"), addUser(t, st, "bob")
	r := root(t, st, owner.ID)
	shared := addNode(t, st, owner.ID, r.ID, KindFolder, "shared")
	private := addNode(t, st, owner.ID, r.ID, KindFolder, "private")
	sub := addNode(t, st, owner.ID, shared.ID, KindFolder, "sub")
	file := addNode(t, st, owner.ID, sub.ID, KindFile, "file")
	addGrant(t, st, owner.ID, bob.ID, shared.ID, RoleEditor)

	roles := func(id string) []string {
		chain, err := st.LineageRoles(ctx, bob.ID, id)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, e := range chain {
			if e.Role != "" {
				out = append(out, e.NodeID+":"+e.Role)
			}
		}
		return out
	}
	if got, want := roles(file.ID), []string{shared.ID + ":editor"}; !slices.Equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if _, err := st.MoveNode(ctx, sub.ID, private.ID, nil, tag("sub"), MoveGuard{}, t0); err != nil {
		t.Fatal(err)
	}
	if got := roles(file.ID); got != nil {
		t.Errorf("moved out, still reached by %v", got)
	}
	wantJournal(t, st, bob.ID, sub.ID, OpRevoked)
	if _, err := st.MoveNode(ctx, sub.ID, shared.ID, nil, tag("sub"), MoveGuard{}, t0); err != nil {
		t.Fatal(err)
	}
	if got := roles(file.ID); len(got) != 1 {
		t.Errorf("moved back, reached by %v", got)
	}
	wantJournal(t, st, bob.ID, sub.ID, OpMoved)
}

func TestLineageRolesStayBoundedOnDeepTrees(t *testing.T) {
	st := open(t)
	owner, bob := addUser(t, st, "owner"), addUser(t, st, "bob")
	r := root(t, st, owner.ID)
	top := addNode(t, st, owner.ID, r.ID, KindFolder, "d")
	addGrant(t, st, owner.ID, bob.ID, top.ID, RoleViewer)
	parent := top.ID
	for range MaxTreeDepth - 2 {
		parent = addNode(t, st, owner.ID, parent, KindFolder, "d").ID
	}
	chain, err := st.LineageRoles(ctx, bob.ID, parent)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain) != MaxTreeDepth || chain[len(chain)-2].Role != RoleViewer {
		t.Errorf("chain of %d, next to last %+v", len(chain), chain[len(chain)-2])
	}
}

func TestEditorMoveStaysInsideOneGrant(t *testing.T) {
	st := open(t)
	owner, bob, other := addUser(t, st, "owner"), addUser(t, st, "bob"), addUser(t, st, "other")
	r := root(t, st, owner.ID)
	one := addNode(t, st, owner.ID, r.ID, KindFolder, "one")
	two := addNode(t, st, owner.ID, r.ID, KindFolder, "two")
	inner := addNode(t, st, owner.ID, one.ID, KindFolder, "inner")
	x := addNode(t, st, owner.ID, one.ID, KindFile, "x")
	addGrant(t, st, owner.ID, bob.ID, one.ID, RoleEditor)
	addGrant(t, st, owner.ID, bob.ID, two.ID, RoleEditor)
	guard := MoveGuard{EditorID: bob.ID}

	_, err := st.MoveNode(ctx, x.ID, two.ID, nil, tag("x"), guard, t0)
	wantErr(t, err, ErrMoveOutOfShare)
	_, err = st.MoveNode(ctx, one.ID, two.ID, nil, tag("one"), guard, t0)
	wantErr(t, err, ErrMoveOutOfShare)
	if _, err = st.MoveNode(ctx, x.ID, inner.ID, nil, tag("x"), guard, t0); err != nil {
		t.Errorf("inside the grant: %v", err)
	}
	otherRoot := root(t, st, other.ID)
	_, err = st.MoveNode(ctx, x.ID, otherRoot.ID, nil, tag("x"), guard, t0)
	wantErr(t, err, ErrMoveAcrossOwners)
}

func TestJournalReachesGrantees(t *testing.T) {
	st := open(t)
	owner, bob, carol := addUser(t, st, "owner"), addUser(t, st, "bob"), addUser(t, st, "carol")
	r := root(t, st, owner.ID)
	shared := addNode(t, st, owner.ID, r.ID, KindFolder, "shared")
	hidden := addNode(t, st, owner.ID, r.ID, KindFile, "hidden")
	g := addGrant(t, st, owner.ID, bob.ID, shared.ID, RoleViewer)
	wantJournal(t, st, bob.ID, shared.ID, OpGranted)

	inside := addNode(t, st, owner.ID, shared.ID, KindFile, "inside")
	wantJournal(t, st, bob.ID, inside.ID, OpCreated)
	wantJournal(t, st, owner.ID, inside.ID, OpCreated)
	if got := journal(t, st, bob.ID); slices.ContainsFunc(got, func(e string) bool { return e == hidden.ID+":"+OpCreated }) {
		t.Errorf("a node out of reach is in the journal: %v", got)
	}
	if got := journal(t, st, carol.ID); len(got) != 0 {
		t.Errorf("a stranger has a journal: %v", got)
	}

	if err := st.DeleteGrant(ctx, g.ID); err != nil {
		t.Fatal(err)
	}
	wantJournal(t, st, bob.ID, shared.ID, OpRevoked)
	before := len(journal(t, st, bob.ID))
	addNode(t, st, owner.ID, shared.ID, KindFile, "after")
	if got := journal(t, st, bob.ID); len(got) != before {
		t.Errorf("revoked and still told: %v", got)
	}
}

func TestTrashTellsGrantsBelow(t *testing.T) {
	st := open(t)
	owner, bob := addUser(t, st, "owner"), addUser(t, st, "bob")
	r := root(t, st, owner.ID)
	folder := addNode(t, st, owner.ID, r.ID, KindFolder, "folder")
	deep := addNode(t, st, owner.ID, folder.ID, KindFile, "deep")
	addGrant(t, st, owner.ID, bob.ID, deep.ID, RoleViewer)
	if _, err := st.TrashNode(ctx, folder.ID, t0); err != nil {
		t.Fatal(err)
	}
	wantJournal(t, st, bob.ID, deep.ID, OpTrashed)
	if _, err := st.RestoreNode(ctx, folder.ID, t0); err != nil {
		t.Fatal(err)
	}
	wantJournal(t, st, bob.ID, deep.ID, OpRestored)
}

func TestGrantGoesWithNodeAndUsers(t *testing.T) {
	st := open(t)
	owner, bob, carol := addUser(t, st, "owner"), addUser(t, st, "bob"), addUser(t, st, "carol")
	r := root(t, st, owner.ID)
	f := addNode(t, st, owner.ID, r.ID, KindFolder, "f")
	addGrant(t, st, owner.ID, bob.ID, f.ID, RoleViewer)
	addGrant(t, st, owner.ID, carol.ID, f.ID, RoleViewer)

	// A grantee going does not disturb anyone else.
	if _, err := st.DeleteUser(ctx, carol.ID); err != nil {
		t.Fatalf("delete grantee: %v", err)
	}
	// An owner going takes the grants, and tells who held them.
	if _, err := st.DeleteUser(ctx, owner.ID); err != nil {
		t.Fatalf("delete owner: %v", err)
	}
	wantJournal(t, st, bob.ID, f.ID, OpRevoked)
	if grants, err := st.ListGrantsForGrantee(ctx, bob.ID, "", 10); err != nil || len(grants) != 0 {
		t.Errorf("grants %v, %v", grants, err)
	}
}

func TestRemovalAppearsForGrantees(t *testing.T) {
	st := open(t)
	owner, bob := addUser(t, st, "owner"), addUser(t, st, "bob")
	r := root(t, st, owner.ID)
	shared := addNode(t, st, owner.ID, r.ID, KindFolder, "shared")
	x := addNode(t, st, owner.ID, shared.ID, KindFile, "x")
	addGrant(t, st, owner.ID, bob.ID, shared.ID, RoleViewer)
	if _, err := st.TrashNode(ctx, x.ID, t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PurgeNode(ctx, x.ID, t0, t0); err != nil {
		t.Fatal(err)
	}
	if n, err := st.RemoveDueNodes(ctx, t0.Add(time.Second), 10); err != nil || n != 1 {
		t.Fatalf("removed %d, %v", n, err)
	}
	wantJournal(t, st, bob.ID, x.ID, OpRemoved)
}

func TestRevokingDropsUploadsThatCannotFinish(t *testing.T) {
	st := open(t)
	owner, bob := addUser(t, st, "owner"), addUser(t, st, "bob")
	r := root(t, st, owner.ID)
	shared := addNode(t, st, owner.ID, r.ID, KindFolder, "shared")
	file := addNode(t, st, owner.ID, shared.ID, KindFile, "file")
	g := addGrant(t, st, owner.ID, bob.ID, shared.ID, RoleEditor)
	if _, err := st.CreateUpload(ctx, Upload{ID: NewID(), UserID: bob.ID, NodeID: file.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 100, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	if got := usage(t, st, owner.ID).ReservedBytes; got != 100 {
		t.Fatalf("owner reserved %d", got)
	}
	if _, err := st.UpdateGrantRole(ctx, g.ID, RoleViewer, nil, t0); err != nil {
		t.Fatal(err)
	}
	if got := usage(t, st, owner.ID).ReservedBytes; got != 0 {
		t.Errorf("owner still reserved %d", got)
	}
}

func rotation(generation int64, children ...RotatedChild) Rotation {
	return Rotation{KeyGeneration: generation, ParentKeyGeneration: 1, WrappedKey: []byte("wrapped"),
		PreviousKey: []byte("previous"), SealedMetadata: []byte("meta"), Children: children}
}

func TestRotation(t *testing.T) {
	st := open(t)
	owner, bob := addUser(t, st, "owner"), addUser(t, st, "bob")
	r := root(t, st, owner.ID)
	f := addNode(t, st, owner.ID, r.ID, KindFolder, "f")
	kept := addNode(t, st, owner.ID, f.ID, KindFile, "kept")
	gone := addNode(t, st, owner.ID, f.ID, KindFile, "gone")
	if _, err := st.TrashNode(ctx, gone.ID, t0); err != nil {
		t.Fatal(err)
	}
	addGrant(t, st, owner.ID, bob.ID, f.ID, RoleViewer)

	children := []RotatedChild{{ID: kept.ID, WrappedKey: []byte("wk"), NameTag: tag("kept2")}, {ID: gone.ID, WrappedKey: []byte("wg"), NameTag: tag("gone2")}}
	grants := []RotatedGrant{{GranteeID: bob.ID, SealedKey: []byte("sk"), Signature: []byte("sig")}}

	good := rotation(1, children...)
	good.Grants = grants
	for name, c := range map[string]struct {
		mod  func(*Rotation)
		want error
	}{
		"stale generation": {func(r *Rotation) { r.KeyGeneration = 2 }, ErrKeyGeneration},
		"stale parent":     {func(r *Rotation) { r.ParentKeyGeneration = 2 }, ErrKeyGeneration},
		"missing child":    {func(r *Rotation) { r.Children = children[:1] }, ErrRotateConflict},
		"repeated child":   {func(r *Rotation) { r.Children = []RotatedChild{children[0], children[0]} }, ErrRotateConflict},
		"foreign child":    {func(r *Rotation) { r.Children = []RotatedChild{children[0], {ID: f.ID, NameTag: tag("x")}} }, ErrRotateConflict},
		"missing grant":    {func(r *Rotation) { r.Grants = nil }, ErrRotateConflict},
		"foreign grant":    {func(r *Rotation) { r.Grants = []RotatedGrant{{GranteeID: owner.ID}} }, ErrRotateConflict},
		"foreign link":     {func(r *Rotation) { r.Links = []RotatedLink{{ID: NewID()}} }, ErrRotateConflict},
	} {
		attempt := good
		c.mod(&attempt)
		_, err := st.RotateNode(ctx, f.ID, attempt, t0)
		if err == nil {
			t.Fatalf("%s: accepted", name)
		}
		wantErr(t, err, c.want)
	}
	if n, _ := st.NodeByID(ctx, f.ID); n.KeyGeneration != 1 {
		t.Fatalf("a refused rotation left generation %d", n.KeyGeneration)
	}

	n, err := st.RotateNode(ctx, f.ID, good, t0)
	if err != nil {
		t.Fatal(err)
	}
	if n.KeyGeneration != 2 || string(n.WrappedKey) != "wrapped" || string(n.SealedMetadata) != "meta" {
		t.Errorf("node %+v", n)
	}
	if c, _ := st.NodeByID(ctx, kept.ID); string(c.WrappedKey) != "wk" || string(c.NameTag) != string(tag("kept2")) || c.KeyGeneration != 1 {
		t.Errorf("child %+v", c)
	}
	held, err := st.ListGrantsForGrantee(ctx, bob.ID, "", 10)
	if err != nil || len(held) != 1 || held[0].KeyGeneration != 2 || string(held[0].SealedKey) != "sk" {
		t.Errorf("grants %+v, %v", held, err)
	}
	wantJournal(t, st, bob.ID, f.ID, OpRotated)
}

func TestRotationRefusesTagsThatCollide(t *testing.T) {
	st := open(t)
	owner := addUser(t, st, "owner")
	r := root(t, st, owner.ID)
	f := addNode(t, st, owner.ID, r.ID, KindFolder, "f")
	a := addNode(t, st, owner.ID, f.ID, KindFile, "a")
	b := addNode(t, st, owner.ID, f.ID, KindFile, "b")
	_, err := st.RotateNode(ctx, f.ID, rotation(1, RotatedChild{ID: a.ID, NameTag: tag("b")}, RotatedChild{ID: b.ID, NameTag: tag("a")}), t0)
	wantErr(t, err, ErrNameConflict)
	_, err = st.RotateNode(ctx, f.ID, rotation(1, RotatedChild{ID: a.ID, NameTag: tag("c")}, RotatedChild{ID: b.ID, NameTag: tag("c")}), t0)
	wantErr(t, err, ErrNameConflict)
}

func TestRotationKeepsVersionsReadable(t *testing.T) {
	st := open(t)
	owner := addUser(t, st, "owner")
	r := root(t, st, owner.ID)
	f := addNode(t, st, owner.ID, r.ID, KindFile, "f")
	old := commit(t, st, owner.ID, f.ID, NewID(), 1, nil)
	if old.KeyGeneration != 1 || len(old.KeyChain) != 0 {
		t.Fatalf("version %+v", old)
	}

	stale := NewID()
	if _, err := st.CreateUpload(ctx, Upload{ID: stale, UserID: owner.ID, NodeID: f.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 1, CreatedAt: t0}); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordFrame(ctx, stale, 0, tag("f"), t0); err != nil {
		t.Fatal(err)
	}
	if _, err := st.RotateNode(ctx, f.ID, rotation(1), t0); err != nil {
		t.Fatal(err)
	}
	_, err := st.CommitUpload(ctx, stale, CommitRequest{Manifest: []byte("m")}, t0, placed)
	wantErr(t, err, ErrKeyGeneration)
	_, err = st.CreateUpload(ctx, Upload{ID: NewID(), UserID: owner.ID, NodeID: f.ID, VersionID: NewID(), Suite: suiteTest,
		FrameCount: 1, FrameSize: 1024, StoredSize: 1, KeyGeneration: 1, CreatedAt: t0})
	wantErr(t, err, ErrKeyGeneration)

	got, err := st.VersionByID(ctx, f.ID, old.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.KeyGeneration != 1 || len(got.KeyChain) != 1 || got.KeyChain[0].Generation != 1 {
		t.Errorf("old version %+v", got)
	}
	if err := st.DeleteUpload(ctx, stale); err != nil {
		t.Fatal(err)
	}
	fresh := commit(t, st, owner.ID, f.ID, NewID(), 1, nil)
	if fresh.KeyGeneration != 2 || len(fresh.KeyChain) != 0 {
		t.Errorf("new version %+v", fresh)
	}
	restored, err := st.RestoreVersion(ctx, f.ID, old.ID, NewID(), owner.ID, nil, t0)
	if err != nil {
		t.Fatal(err)
	}
	if restored.KeyGeneration != 1 || len(restored.KeyChain) != 1 {
		t.Errorf("a restored version keeps its generation: %+v", restored)
	}
}

func TestStaleKeyGenerationsAreRefused(t *testing.T) {
	st := open(t)
	owner := addUser(t, st, "owner")
	r := root(t, st, owner.ID)
	f := addNode(t, st, owner.ID, r.ID, KindFolder, "f")
	other := addNode(t, st, owner.ID, r.ID, KindFolder, "other")
	file := addNode(t, st, owner.ID, f.ID, KindFile, "file")
	if _, err := st.RotateNode(ctx, f.ID, rotation(1, RotatedChild{ID: file.ID, NameTag: tag("file")}), t0); err != nil {
		t.Fatal(err)
	}
	stale, current := int64(1), int64(2)

	_, err := st.CreateNode(ctx, child(NewID(), owner.ID, f.ID, KindFile, "new"), &stale)
	wantErr(t, err, ErrKeyGeneration)
	if _, err := st.CreateNode(ctx, child(NewID(), owner.ID, f.ID, KindFile, "new"), &current); err != nil {
		t.Error(err)
	}
	_, err = st.UpdateNode(ctx, f.ID, []byte("m"), nil, KeyCheck{Node: &stale}, t0)
	wantErr(t, err, ErrKeyGeneration)
	_, err = st.UpdateNode(ctx, file.ID, nil, tag("r"), KeyCheck{Parent: &stale}, t0)
	wantErr(t, err, ErrKeyGeneration)
	_, err = st.MoveNode(ctx, other.ID, f.ID, nil, tag("o"), MoveGuard{ParentGeneration: &stale}, t0)
	wantErr(t, err, ErrKeyGeneration)
	if _, err = st.MoveNode(ctx, other.ID, f.ID, nil, tag("o"), MoveGuard{ParentGeneration: &current}, t0); err != nil {
		t.Error(err)
	}
}

func addLink(t *testing.T, st *Store, owner, node string, limit int64) Link {
	t.Helper()
	l, err := st.CreateLink(ctx, Link{ID: NewID(), NodeID: node, OwnerID: owner, Role: LinkRoleView, KeyGeneration: 1,
		DownloadLimit: limit, CreatedAt: t0})
	if err != nil {
		t.Fatalf("CreateLink: %v", err)
	}
	return l
}

func TestLinkDownloadLimitHoldsUnderRace(t *testing.T) {
	st := open(t)
	owner := addUser(t, st, "owner")
	r := root(t, st, owner.ID)
	f := addNode(t, st, owner.ID, r.ID, KindFile, "f")
	l := addLink(t, st, owner.ID, f.ID, 3)

	var wg sync.WaitGroup
	var won atomic.Int32
	for range 20 {
		wg.Go(func() {
			if err := st.ClaimLinkDownload(ctx, l.ID, NewID(), f.ID, t0); err == nil {
				won.Add(1)
			}
		})
	}
	wg.Wait()
	if won.Load() != 3 {
		t.Errorf("%d claims won, limit 3", won.Load())
	}
	got, _ := st.LinkByID(ctx, l.ID)
	if got.DownloadCount != 3 {
		t.Errorf("count %d", got.DownloadCount)
	}
}

func TestLinkClaimCountsOncePerSession(t *testing.T) {
	st := open(t)
	owner := addUser(t, st, "owner")
	r := root(t, st, owner.ID)
	f := addNode(t, st, owner.ID, r.ID, KindFile, "f")
	l := addLink(t, st, owner.ID, f.ID, 1)
	session := NewID()
	for range 3 {
		if err := st.ClaimLinkDownload(ctx, l.ID, session, f.ID, t0); err != nil {
			t.Fatal(err)
		}
	}
	wantErr(t, st.ClaimLinkDownload(ctx, l.ID, NewID(), f.ID, t0), ErrLinkLimit)
	// Forgetting a stale claim gives nothing back to the limit.
	if err := st.RemoveStaleLinkDownloads(ctx, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	wantErr(t, st.ClaimLinkDownload(ctx, l.ID, session, f.ID, t0), ErrLinkLimit)
}

func TestNodeVisibleUnder(t *testing.T) {
	st := open(t)
	owner := addUser(t, st, "owner")
	r := root(t, st, owner.ID)
	top := addNode(t, st, owner.ID, r.ID, KindFolder, "top")
	shared := addNode(t, st, owner.ID, top.ID, KindFolder, "shared")
	inner := addNode(t, st, owner.ID, shared.ID, KindFile, "inner")
	outside := addNode(t, st, owner.ID, top.ID, KindFile, "outside")
	for _, c := range []struct {
		node string
		want bool
	}{{shared.ID, true}, {inner.ID, true}, {outside.ID, false}, {top.ID, false}, {r.ID, false}} {
		if got, err := st.NodeVisibleUnder(ctx, shared.ID, c.node); err != nil || got != c.want {
			t.Errorf("%s: got %v, %v", c.node, got, err)
		}
	}
	if _, err := st.TrashNode(ctx, top.ID, t0); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.NodeVisibleUnder(ctx, shared.ID, inner.ID); got {
		t.Error("a folder above is in the trash and the node is still visible")
	}
}
