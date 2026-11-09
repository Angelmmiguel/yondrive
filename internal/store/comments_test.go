package store

import (
	"testing"
	"time"
)

func newComment(node, author string) Comment {
	c := Comment{ID: NewID(), NodeID: node, AuthorID: author, KeyGeneration: 1, SealedBody: []byte(`{"text":"x"}`), CreatedAt: t0}
	c.ThreadID = c.ID
	return c
}

func TestCommentsStopAtTheLimit(t *testing.T) {
	st := open(t)
	u := addUser(t, st, "alice")
	r := root(t, st, u.ID)
	file := addNode(t, st, u.ID, r.ID, KindFile, "file")
	for range 3 {
		if _, err := st.CreateComment(ctx, newComment(file.ID, u.ID), 3); err != nil {
			t.Fatal(err)
		}
	}
	_, err := st.CreateComment(ctx, newComment(file.ID, u.ID), 3)
	wantErr(t, err, ErrCommentLimit)

	// Another file has room of its own.
	other := addNode(t, st, u.ID, r.ID, KindFile, "other")
	if _, err := st.CreateComment(ctx, newComment(other.ID, u.ID), 3); err != nil {
		t.Errorf("another file: %v", err)
	}
}

func TestCommentNoticesGatherPerFile(t *testing.T) {
	st := open(t)
	alice := addUser(t, st, "alice")
	bob := addUser(t, st, "bob")
	carol := addUser(t, st, "carol")
	r := root(t, st, alice.ID)
	folder := addNode(t, st, alice.ID, r.ID, KindFolder, "folder")
	sub := addNode(t, st, alice.ID, folder.ID, KindFolder, "sub")
	file := addNode(t, st, alice.ID, sub.ID, KindFile, "file")
	addGrant(t, st, alice.ID, bob.ID, folder.ID, RoleCommenter)
	addGrant(t, st, alice.ID, carol.ID, sub.ID, RoleViewer)

	first := newComment(file.ID, bob.ID)
	if _, err := st.CreateComment(ctx, first, 10); err != nil {
		t.Fatal(err)
	}
	second := newComment(file.ID, bob.ID)
	second.ThreadID, second.CreatedAt = first.ID, t0.Add(time.Minute)
	if _, err := st.CreateComment(ctx, second, 10); err != nil {
		t.Fatal(err)
	}
	for _, u := range []User{alice, carol} {
		notices, err := st.ListCommentNotices(ctx, u.ID, 10)
		if err != nil || len(notices) != 1 || notices[0].Count != 2 || notices[0].CommentID != second.ID || notices[0].AuthorID != bob.ID {
			t.Errorf("%s: %+v, %v", u.Username, notices, err)
		}
	}
	if notices, _ := st.ListCommentNotices(ctx, bob.ID, 10); len(notices) != 0 {
		t.Errorf("the author: %+v", notices)
	}
	wantJournal(t, st, carol.ID, file.ID, OpCommented)
	if n, _ := st.NodeByID(ctx, file.ID); n.CommentSeq != 2 {
		t.Errorf("comment_seq = %d", n.CommentSeq)
	}

	if err := st.MarkCommentNoticesRead(ctx, alice.ID, []string{file.ID}); err != nil {
		t.Fatal(err)
	}
	if notices, _ := st.ListCommentNotices(ctx, alice.ID, 10); len(notices) != 0 {
		t.Errorf("marked: %+v", notices)
	}
	if err := st.MarkCommentNoticesRead(ctx, carol.ID, nil); err != nil {
		t.Fatal(err)
	}
	if notices, _ := st.ListCommentNotices(ctx, carol.ID, 10); len(notices) != 0 {
		t.Errorf("all marked: %+v", notices)
	}

	// A reply to a reply, and an anchor on a reply, are refused.
	deeper := newComment(file.ID, bob.ID)
	deeper.ThreadID = second.ID
	_, err := st.CreateComment(ctx, deeper, 10)
	wantErr(t, err, ErrNotThread)
	_, err = st.SetCommentAnchor(ctx, file.ID, second.ID, CommentAnchor{KeyGeneration: 1, Sealed: []byte("{}"), SignerID: alice.ID}, t0)
	wantErr(t, err, ErrNotThread)

	// The thread's first comment takes its replies with it.
	if err := st.DeleteComment(ctx, file.ID, first.ID, "", t0); err != nil {
		t.Fatal(err)
	}
	if left, _ := st.ListComments(ctx, file.ID, 0, 10); len(left) != 0 {
		t.Errorf("left %+v", left)
	}
	wantErr(t, st.DeleteComment(ctx, file.ID, first.ID, "", t0), ErrNotFound)
}

func TestCommentsGoWithTheirAuthor(t *testing.T) {
	st := open(t)
	alice := addUser(t, st, "alice")
	bob := addUser(t, st, "bob")
	r := root(t, st, alice.ID)
	file := addNode(t, st, alice.ID, r.ID, KindFile, "file")
	addGrant(t, st, alice.ID, bob.ID, file.ID, RoleCommenter)
	c := newComment(file.ID, bob.ID)
	if _, err := st.CreateComment(ctx, c, 10); err != nil {
		t.Fatal(err)
	}
	reply := newComment(file.ID, alice.ID)
	reply.ThreadID = c.ID
	if _, err := st.CreateComment(ctx, reply, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DeleteUser(ctx, bob.ID); err != nil {
		t.Fatal(err)
	}
	if left, _ := st.ListComments(ctx, file.ID, 0, 10); len(left) != 0 {
		t.Errorf("left %+v", left)
	}
}

func TestAnAuthorKeepsOthersReplies(t *testing.T) {
	st := open(t)
	alice := addUser(t, st, "alice")
	bob := addUser(t, st, "bob")
	r := root(t, st, alice.ID)
	file := addNode(t, st, alice.ID, r.ID, KindFile, "file")
	first := newComment(file.ID, bob.ID)
	if _, err := st.CreateComment(ctx, first, 10); err != nil {
		t.Fatal(err)
	}
	reply := newComment(file.ID, alice.ID)
	reply.ThreadID = first.ID
	if _, err := st.CreateComment(ctx, reply, 10); err != nil {
		t.Fatal(err)
	}
	wantErr(t, st.DeleteComment(ctx, file.ID, first.ID, bob.ID, t0), ErrHasReplies)
	if err := st.DeleteComment(ctx, file.ID, first.ID, "", t0); err != nil {
		t.Errorf("the owner's delete: %v", err)
	}
}
