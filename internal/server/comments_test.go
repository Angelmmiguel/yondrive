package server_test

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/Angelmmiguel/yondrive/internal/store"
)

type commentBody struct {
	ID             string `json:"id"`
	NodeID         string `json:"node_id"`
	ThreadID       string `json:"thread_id"`
	AuthorID       string `json:"author_id"`
	AuthorUsername string `json:"author_username"`
	KeyGeneration  int64  `json:"key_generation"`
	SealedBody     string `json:"sealed_body"`
	Signature      string `json:"signature"`
	EditedAt       string `json:"edited_at"`
	Resolved       bool   `json:"resolved"`
	ResolvedBy     string `json:"resolved_by"`
	Anchor         *struct {
		KeyGeneration int64  `json:"key_generation"`
		SealedAnchor  string `json:"sealed_anchor"`
		Signature     string `json:"signature"`
		SignerID      string `json:"signer_id"`
	} `json:"anchor"`
}

type commentPageBody struct {
	Comments []commentBody `json:"comments"`
	KeyChain []struct {
		Generation int64  `json:"generation"`
		SealedKey  string `json:"sealed_key"`
	} `json:"key_chain"`
	NextCursor string `json:"next_cursor"`
}

// sealedComment stands for a body or an anchor: sealed bytes with keys, readable
// JSON without.
func (d *driveUser) sealedComment(text string) string {
	if d.mode == "e2e" {
		return b64(append(fill(5, 41), []byte(text)...))
	}
	return b64([]byte(`{"text":"` + text + `"}`))
}

func (d *driveUser) commentRequest(text string, generation int64) obj {
	return obj{"id": store.NewID(), "key_generation": generation, "sealed_body": d.sealedComment(text), "signature": d.signature()}
}

func (d *driveUser) anchorRequest(text string, generation int64) obj {
	return obj{"key_generation": generation, "sealed_anchor": d.sealedComment(text), "signature": d.signature()}
}

func (d *driveUser) comment(file string, body obj) commentBody {
	d.e.t.Helper()
	resp := d.call(http.MethodPost, api+"/nodes/"+file+"/comments", body)
	resp.wantStatus(d.e.t, http.StatusCreated)
	var c commentBody
	resp.decode(d.e.t, &c)
	return c
}

func (d *driveUser) comments(file string) commentPageBody {
	d.e.t.Helper()
	resp := d.call(http.MethodGet, api+"/nodes/"+file+"/comments", nil)
	resp.wantStatus(d.e.t, http.StatusOK)
	var page commentPageBody
	resp.decode(d.e.t, &page)
	return page
}

type noticesBody struct {
	Notifications []struct {
		GrantID string `json:"grant_id"`
	} `json:"notifications"`
	Comments []struct {
		NodeID    string `json:"node_id"`
		CommentID string `json:"comment_id"`
		AuthorID  string `json:"author_id"`
		Count     int    `json:"count"`
	} `json:"comments"`
}

func (d *driveUser) notices() noticesBody {
	d.e.t.Helper()
	resp := d.call(http.MethodGet, api+"/notifications", nil)
	resp.wantStatus(d.e.t, http.StatusOK)
	var out noticesBody
	resp.decode(d.e.t, &out)
	return out
}

// commentedFile is a file of alice's in a folder shared with each user at a role.
func commentedFile(t *testing.T, alice *driveUser, shares map[*driveUser]string) (folder, file nodeBody) {
	t.Helper()
	root := alice.root()
	folder = alice.create(root.ID, "folder", "shared")
	for user, role := range shares {
		alice.share(folder.ID, user, role)
	}
	file = alice.create(folder.ID, "file", "notes.docx")
	alice.upload(file.ID, alice.frames(100, 1))
	return folder, file
}

func TestCommentRolesAndThreads(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		carol := newDriveUser(e, e.login("root"), "carol", mode)
		dave := newDriveUser(e, e.login("root"), "dave", mode)
		_, file := commentedFile(t, alice, map[*driveUser]string{bob: "commenter", carol: "viewer", dave: "editor"})
		path := api + "/nodes/" + file.ID + "/comments"

		if resp := bob.call(http.MethodGet, api+"/nodes/"+file.ID, nil); !strings.Contains(string(resp.body), `"role":"commenter"`) {
			t.Errorf("bob's node %s", resp.body)
		}
		// A commenter writes no content and sends no heartbeat.
		bob.call(http.MethodPut, api+"/nodes/"+file.ID+"/editing", nil).wantError(t, http.StatusForbidden, "forbidden")
		bob.call(http.MethodPost, api+"/uploads", bob.uploadRequest(file.ID, bob.frames(10, 2))).wantError(t, http.StatusForbidden, "forbidden")

		// A viewer reads and does not write.
		carol.call(http.MethodPost, path, carol.commentRequest("no", 1)).wantError(t, http.StatusForbidden, "forbidden")

		start := bob.commentRequest("first", 1)
		start["anchor"] = bob.anchorRequest("cell B2", 1)
		thread := bob.comment(file.ID, start)
		if thread.ThreadID != thread.ID || thread.AuthorID != bob.id || thread.AuthorUsername != "bob" || thread.Anchor == nil ||
			thread.Anchor.SignerID != bob.id || thread.SealedBody != bob.sealedComment("first") || thread.Resolved {
			t.Fatalf("thread %+v", thread)
		}
		if !e.audited("comment_created") {
			t.Error("no audit row")
		}
		reply := alice.commentRequest("reply", 1)
		reply["thread_id"] = thread.ID
		answer := alice.comment(file.ID, reply)
		if answer.ThreadID != thread.ID || answer.Anchor != nil {
			t.Errorf("reply %+v", answer)
		}

		// Replies hang off a thread's first comment, which alone has an anchor.
		deeper := carol.commentRequest("x", 1)
		deeper["thread_id"] = answer.ID
		bob.call(http.MethodPost, path, deeper).wantError(t, http.StatusBadRequest, "invalid_comment")
		anchored := bob.commentRequest("x", 1)
		anchored["thread_id"] = thread.ID
		anchored["anchor"] = bob.anchorRequest("a", 1)
		bob.call(http.MethodPost, path, anchored).wantError(t, http.StatusBadRequest, "invalid_comment")
		missing := bob.commentRequest("x", 1)
		missing["thread_id"] = store.NewID()
		bob.call(http.MethodPost, path, missing).wantError(t, http.StatusNotFound, "not_found")
		again := bob.commentRequest("x", 1)
		again["id"] = thread.ID
		bob.call(http.MethodPost, path, again).wantError(t, http.StatusConflict, "id_taken")

		page := carol.comments(file.ID)
		if len(page.Comments) != 2 || page.Comments[0].ID != thread.ID || page.Comments[1].ID != answer.ID || page.KeyChain != nil {
			t.Errorf("list %+v", page)
		}

		// The author edits their own, and nobody else does.
		edit := obj{"key_generation": 1, "sealed_body": bob.sealedComment("first, edited"), "signature": bob.signature()}
		dave.call(http.MethodPut, path+"/"+thread.ID, edit).wantError(t, http.StatusForbidden, "forbidden")
		resp := bob.call(http.MethodPut, path+"/"+thread.ID, edit)
		resp.wantStatus(t, http.StatusOK)
		var edited commentBody
		resp.decode(t, &edited)
		if edited.SealedBody != bob.sealedComment("first, edited") || edited.EditedAt == "" {
			t.Errorf("edited %+v", edited)
		}

		// Editors resolve, reopen and move anchors; a commenter does none of it.
		bob.call(http.MethodPut, path+"/"+thread.ID+"/resolved", obj{"resolved": true}).wantError(t, http.StatusForbidden, "forbidden")
		resp = dave.call(http.MethodPut, path+"/"+thread.ID+"/resolved", obj{"resolved": true})
		resp.wantStatus(t, http.StatusOK)
		var resolved commentBody
		resp.decode(t, &resolved)
		if !resolved.Resolved || resolved.ResolvedBy != dave.id {
			t.Errorf("resolved %+v", resolved)
		}
		dave.call(http.MethodPut, path+"/"+answer.ID+"/resolved", obj{"resolved": true}).wantError(t, http.StatusBadRequest, "invalid_comment")
		resp = alice.call(http.MethodPut, path+"/"+thread.ID+"/resolved", obj{"resolved": false})
		var reopened commentBody
		resp.decode(t, &reopened)
		if reopened.Resolved || reopened.ResolvedBy != "" {
			t.Errorf("reopened %+v", reopened)
		}
		bob.call(http.MethodPut, path+"/"+thread.ID+"/anchor", bob.anchorRequest("B3", 1)).wantError(t, http.StatusForbidden, "forbidden")
		resp = dave.call(http.MethodPut, path+"/"+thread.ID+"/anchor", dave.anchorRequest("cell B3", 1))
		resp.wantStatus(t, http.StatusOK)
		var moved commentBody
		resp.decode(t, &moved)
		if moved.Anchor == nil || moved.Anchor.SignerID != dave.id || moved.Anchor.SealedAnchor != dave.sealedComment("cell B3") {
			t.Errorf("moved %+v", moved)
		}
		dave.call(http.MethodPut, path+"/"+answer.ID+"/anchor", dave.anchorRequest("x", 1)).wantError(t, http.StatusBadRequest, "invalid_comment")
		for _, action := range []string{"comment_edited", "comment_resolved", "comment_reopened", "comment_anchored"} {
			if !e.audited(action) {
				t.Errorf("no audit row for %s", action)
			}
		}

		// Deleting: the author while they may comment, and the owner anything.
		carol.call(http.MethodDelete, path+"/"+answer.ID, nil).wantError(t, http.StatusForbidden, "forbidden")
		dave.call(http.MethodDelete, path+"/"+answer.ID, nil).wantError(t, http.StatusForbidden, "forbidden")
		alice.call(http.MethodDelete, path+"/"+answer.ID, nil).wantStatus(t, http.StatusNoContent)
		late := carol.commentRequest("x", 1)
		late["thread_id"] = thread.ID
		mine := bob.comment(file.ID, late)
		bob.call(http.MethodDelete, path+"/"+mine.ID, nil).wantStatus(t, http.StatusNoContent)
		bob.call(http.MethodDelete, path+"/"+mine.ID, nil).wantError(t, http.StatusNotFound, "not_found")
		other := bob.commentRequest("y", 1)
		other["thread_id"] = thread.ID
		bob.comment(file.ID, other)
		// Its author takes no one else's replies with a thread, while the owner may.
		answered := alice.commentRequest("z", 1)
		answered["thread_id"] = thread.ID
		alice.comment(file.ID, answered)
		bob.call(http.MethodDelete, path+"/"+thread.ID, nil).wantError(t, http.StatusConflict, "comment_has_replies")
		own := bob.comment(file.ID, bob.commentRequest("alone", 1))
		mineToo := bob.commentRequest("me again", 1)
		mineToo["thread_id"] = own.ID
		bob.comment(file.ID, mineToo)
		bob.call(http.MethodDelete, path+"/"+own.ID, nil).wantStatus(t, http.StatusNoContent)
		alice.call(http.MethodDelete, path+"/"+thread.ID, nil).wantStatus(t, http.StatusNoContent)
		if page := alice.comments(file.ID); len(page.Comments) != 0 {
			t.Errorf("a deleted thread keeps %+v", page.Comments)
		}
		if !e.audited("comment_deleted") {
			t.Error("no audit row for a delete")
		}
	})
}

func TestCommentRefusals(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		folder, file := commentedFile(t, alice, map[*driveUser]string{bob: "commenter"})
		path := api + "/nodes/" + file.ID + "/comments"
		with := func(k string, v any) obj {
			b := alice.commentRequest("text", 1)
			b[k] = v
			return b
		}
		alice.call(http.MethodPost, path, with("sealed_body", "")).wantError(t, http.StatusBadRequest, "invalid_comment")
		alice.call(http.MethodPost, path, with("sealed_body", b64(fill(1, 16<<10+1)))).wantError(t, http.StatusRequestEntityTooLarge, "comment_too_large")
		alice.call(http.MethodPost, path, with("anchor", obj{"key_generation": 1, "sealed_anchor": b64(fill(1, 4<<10+1)), "signature": alice.signature()})).
			wantError(t, http.StatusRequestEntityTooLarge, "comment_too_large")
		alice.call(http.MethodPost, path, with("id", "nope")).wantError(t, http.StatusBadRequest, "invalid_id")
		alice.call(http.MethodPost, path, with("thread_id", "NOPE")).wantError(t, http.StatusBadRequest, "invalid_id")
		if mode == "e2e" {
			alice.call(http.MethodPost, path, with("signature", b64(fill(1, 63)))).wantError(t, http.StatusBadRequest, "invalid_comment")
			alice.call(http.MethodPost, path, with("sealed_body", b64(fill(1, 41)))).wantError(t, http.StatusBadRequest, "invalid_comment")
		} else {
			alice.call(http.MethodPost, path, with("signature", b64(fill(1, 64)))).wantError(t, http.StatusBadRequest, "invalid_comment")
		}
		alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/comments?cursor=0", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
		alice.call(http.MethodPut, path+"/nope", obj{"key_generation": 1, "sealed_body": alice.sealedComment("x"), "signature": alice.signature()}).
			wantError(t, http.StatusBadRequest, "invalid_id")

		// Folders take no comments, and strangers learn nothing.
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/comments", alice.commentRequest("x", 1)).wantError(t, http.StatusConflict, "not_a_file")
		carol := newDriveUser(e, e.login("root"), "carol", mode)
		carol.call(http.MethodGet, path, nil).wantError(t, http.StatusNotFound, "not_found")
		carol.call(http.MethodPost, path, carol.commentRequest("x", 1)).wantError(t, http.StatusNotFound, "not_found")

		// Sealed under a key that has moved on.
		alice.call(http.MethodPost, path, alice.commentRequest("x", 2)).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")

		// The trash keeps comments as they were.
		c := bob.comment(file.ID, bob.commentRequest("kept", 1))
		alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/trash", nil).wantStatus(t, http.StatusOK)
		alice.call(http.MethodPost, path, alice.commentRequest("x", 1)).wantError(t, http.StatusConflict, "node_trashed")
		alice.call(http.MethodDelete, path+"/"+c.ID, nil).wantError(t, http.StatusConflict, "node_trashed")
		bob.call(http.MethodGet, path, nil).wantError(t, http.StatusNotFound, "not_found")
		if page := alice.comments(file.ID); len(page.Comments) != 1 {
			t.Errorf("trash took %+v", page.Comments)
		}
	})
}

func TestCommentsFollowRotation(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, _ := driveEnv(t, mode)
		_, file := commentedFile(t, alice, nil)
		path := api + "/nodes/" + file.ID + "/comments"
		before := alice.comment(file.ID, alice.commentRequest("before", 1))
		body := rotateBody(alice, 1)
		body["parent_key_generation"] = 1
		alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/rotate", body).wantStatus(t, http.StatusOK)

		alice.call(http.MethodPost, path, alice.commentRequest("stale", 1)).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")
		after := alice.comment(file.ID, alice.commentRequest("after", 2))
		alice.call(http.MethodPut, path+"/"+before.ID, obj{"key_generation": 1, "sealed_body": alice.sealedComment("x"), "signature": alice.signature()}).
			wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")
		page := alice.comments(file.ID)
		if len(page.Comments) != 2 || page.Comments[0].KeyGeneration != 1 || page.Comments[1].KeyGeneration != 2 {
			t.Fatalf("list %+v", page.Comments)
		}
		// The old comment's key is one link down the chain. Without keys there is none.
		if mode == "e2e" && (len(page.KeyChain) != 1 || page.KeyChain[0].Generation != 1 || page.KeyChain[0].SealedKey != alice.sealedKey()) {
			t.Errorf("chain %+v", page.KeyChain)
		}
		if mode == "none" && page.KeyChain != nil {
			t.Errorf("chain without keys %+v", page.KeyChain)
		}
		alice.call(http.MethodDelete, path+"/"+before.ID, nil).wantStatus(t, http.StatusNoContent)
		if page := alice.comments(file.ID); page.KeyChain != nil || len(page.Comments) != 1 || page.Comments[0].ID != after.ID {
			t.Errorf("after the old one went %+v", page)
		}
	})
}

func TestCommentsPage(t *testing.T) {
	_, alice, _ := driveEnv(t, "none")
	_, file := commentedFile(t, alice, nil)
	var ids []string
	for range 5 {
		ids = append(ids, alice.comment(file.ID, alice.commentRequest("c", 1)).ID)
	}
	var got []string
	cursor := ""
	for range 4 {
		resp := alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/comments?limit=2"+cursor, nil)
		resp.wantStatus(t, http.StatusOK)
		var page commentPageBody
		resp.decode(t, &page)
		for _, c := range page.Comments {
			got = append(got, c.ID)
		}
		if page.NextCursor == "" {
			break
		}
		cursor = "&cursor=" + page.NextCursor
	}
	if !slices.Equal(got, ids) {
		t.Errorf("paged %v, want %v", got, ids)
	}
}

func TestCommentNoticesAndJournal(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		carol := newDriveUser(e, e.login("root"), "carol", mode)
		dave := newDriveUser(e, e.login("root"), "dave", mode)
		_, file := commentedFile(t, alice, map[*driveUser]string{bob: "commenter", carol: "viewer"})
		journalOf(t, bob)

		thread := bob.comment(file.ID, bob.commentRequest("one", 1))
		reply := bob.commentRequest("two", 1)
		reply["thread_id"] = thread.ID
		last := bob.comment(file.ID, reply)

		// Everyone who reads the file hears of it but the author, and a stranger nothing.
		for _, who := range []*driveUser{alice, carol} {
			n := who.notices()
			if len(n.Comments) != 1 || n.Comments[0].NodeID != file.ID || n.Comments[0].CommentID != last.ID ||
				n.Comments[0].AuthorID != bob.id || n.Comments[0].Count != 2 {
				t.Errorf("%s notices %+v", who.id, n.Comments)
			}
		}
		if n := bob.notices(); len(n.Comments) != 0 {
			t.Errorf("the author hears of their own: %+v", n.Comments)
		}
		if n := dave.notices(); len(n.Comments) != 0 {
			t.Errorf("a stranger hears: %+v", n.Comments)
		}
		if !slices.Contains(journalOf(t, carol), file.ID+" commented") {
			t.Error("no journal entry for a reader")
		}
		resp := alice.call(http.MethodGet, api+"/nodes/"+file.ID, nil)
		if !strings.Contains(string(resp.body), `"comment_seq":2`) {
			t.Errorf("node %s", resp.body)
		}

		// Marking grants alone leaves comments; naming the file clears them.
		alice.call(http.MethodPost, api+"/notifications/read", obj{"grant_ids": []string{}}).wantStatus(t, http.StatusNoContent)
		if n := alice.notices(); len(n.Comments) != 1 {
			t.Errorf("grants took comments: %+v", n.Comments)
		}
		alice.call(http.MethodPost, api+"/notifications/read", obj{"node_ids": []string{"bad"}}).wantError(t, http.StatusBadRequest, "invalid_id")
		alice.call(http.MethodPost, api+"/notifications/read", obj{"node_ids": []string{file.ID}}).wantStatus(t, http.StatusNoContent)
		if n := alice.notices(); len(n.Comments) != 0 {
			t.Errorf("marked and still %+v", n.Comments)
		}
		// An empty body marks everything.
		if n := carol.notices(); len(n.Notifications) != 1 || len(n.Comments) != 1 {
			t.Fatalf("carol %+v", n)
		}
		carol.call(http.MethodPost, api+"/notifications/read", obj{}).wantStatus(t, http.StatusNoContent)
		if n := carol.notices(); len(n.Notifications) != 0 || len(n.Comments) != 0 {
			t.Errorf("carol after all %+v", n)
		}

		// Someone who can no longer read the file is not told of it.
		alice.comment(file.ID, alice.commentRequest("three", 1))
		if n := carol.notices(); len(n.Comments) != 1 {
			t.Fatalf("carol %+v", n.Comments)
		}
		alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/trash", nil).wantStatus(t, http.StatusOK)
		if n := carol.notices(); len(n.Comments) != 0 {
			t.Errorf("a trashed file still notifies %+v", n.Comments)
		}
	})
}

func TestCommenterSeesWhoMayComment(t *testing.T) {
	e, alice, bob := driveEnv(t, "none")
	carol := newDriveUser(e, e.login("root"), "carol", "none")
	_, file := commentedFile(t, alice, map[*driveUser]string{bob: "commenter", carol: "viewer"})
	var access struct {
		Access []struct {
			Username string `json:"username"`
			Role     string `json:"role"`
		} `json:"access"`
	}
	resp := carol.call(http.MethodGet, api+"/nodes/"+file.ID+"/grants", nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &access)
	var names []string
	for _, a := range access.Access {
		names = append(names, a.Username+":"+a.Role)
	}
	slices.Sort(names)
	if !slices.Equal(names, []string{"bob:commenter", "carol:viewer"}) {
		t.Errorf("carol sees %v", names)
	}
}

func TestCommentsGoWithTheirFile(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	_, file := commentedFile(t, alice, map[*driveUser]string{bob: "commenter"})
	c := bob.comment(file.ID, bob.commentRequest("x", 1))
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/purge", nil).wantStatus(t, http.StatusOK)
	if _, err := alice.e.st.CommentByID(ctx, file.ID, c.ID); err != nil {
		t.Fatalf("a purge marks, and the comment waits with the file: %v", err)
	}
	alice.e.advance(400 * day)
	if err := alice.e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := alice.e.st.CommentByID(ctx, file.ID, c.ID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("a comment outlived its file: %v", err)
	}
	alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/comments", nil).wantError(t, http.StatusNotFound, "not_found")
}
