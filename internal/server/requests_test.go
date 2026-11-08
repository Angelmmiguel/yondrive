package server_test

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"time"
	"net/http"
	"testing"

	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

type requestLinkBody struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Role          string `json:"role"`
	SealedKey     string `json:"sealed_key"`
	PublicKey     string `json:"public_key"`
	MaxFileSize   int64  `json:"max_file_size"`
	FileLimit     int64  `json:"file_limit"`
	BytesLimit    int64  `json:"bytes_limit"`
	FilesReceived int64  `json:"files_received"`
	BytesReceived int64  `json:"bytes_received"`
}

type publicRequestBody struct {
	ID             string         `json:"id"`
	State          string         `json:"state"`
	KDF            map[string]any `json:"kdf"`
	Suite          string         `json:"suite"`
	PublicKey      *string        `json:"public_key"`
	Token          string         `json:"token"`
	Node           any            `json:"node"`
	FilesRemaining *int64         `json:"files_remaining"`
	BytesRemaining *int64         `json:"bytes_remaining"`
	MaxFileSize    *int64         `json:"max_file_size"`
}

type incomingBody struct {
	ID               string `json:"id"`
	LinkID           string `json:"link_id"`
	FolderID         string `json:"folder_id"`
	SealedKey        string `json:"sealed_key"`
	SealedMetadata   string `json:"sealed_metadata"`
	PublicKey        string `json:"public_key"`
	SealedPrivateKey string `json:"sealed_private_key"`
	VersionID        string `json:"version_id"`
	BlobID           string `json:"blob_id"`
	Size             int64  `json:"size"`
	StoredSize       int64  `json:"stored_size"`
	FrameHashes      string `json:"frame_hashes"`
}

func (d *driveUser) publicKey() string {
	if d.mode == "e2e" {
		return b64(fill(6, 32))
	}
	return ""
}

func (d *driveUser) requestRequest(folder string, extra ...any) obj {
	req := obj{"id": store.NewID(), "node_id": folder, "kind": "request", "key_generation": 1, "sealed_key": "",
		"owner_sealed_key": d.sealedKey(), "public_key": d.publicKey()}
	for i := 0; i+1 < len(extra); i += 2 {
		req[extra[i].(string)] = extra[i+1]
	}
	return req
}

func (d *driveUser) request(folder string, extra ...any) requestLinkBody {
	d.e.t.Helper()
	resp := d.call(http.MethodPost, api+"/links", d.requestRequest(folder, extra...))
	resp.wantStatus(d.e.t, http.StatusCreated)
	var l requestLinkBody
	resp.decode(d.e.t, &l)
	return l
}

func openRequest(e *env, id string, header ...string) publicRequestBody {
	e.t.Helper()
	resp := e.call(http.MethodGet, api+"/public/requests/"+id, nil, header...)
	resp.wantStatus(e.t, http.StatusOK)
	var r publicRequestBody
	resp.decode(e.t, &r)
	return r
}

// sender sends files through a request, as someone with no account.
type sender struct {
	e     *env
	d     *driveUser
	id    string
	token string
}

func (s sender) post(path string, body any) response {
	s.e.t.Helper()
	return s.e.call(http.MethodPost, api+"/public/requests/"+s.id+path, body, "X-Link-Token", s.token)
}

func (s sender) uploadRequest(frames [][]byte, extra ...any) obj {
	req := obj{"suite": s.d.suite, "frame_count": len(frames), "frame_size": testFrameSize, "stored_size": stored(frames)}
	for i := 0; i+1 < len(extra); i += 2 {
		req[extra[i].(string)] = extra[i+1]
	}
	return req
}

// commitBody is what a sender seals of a file, which comes with its commit.
func (s sender) commitBody(extra ...any) obj {
	sealed := ""
	if s.d.mode == "e2e" {
		sealed = b64(fill(3, 105))
	}
	req := obj{"sealed_key": sealed, "sealed_metadata": b64([]byte("sealed name"))}
	for i := 0; i+1 < len(extra); i += 2 {
		req[extra[i].(string)] = extra[i+1]
	}
	return req
}

func (s sender) start(frames [][]byte, extra ...any) uploadBody {
	s.e.t.Helper()
	resp := s.post("/uploads", s.uploadRequest(frames, extra...))
	resp.wantStatus(s.e.t, http.StatusCreated)
	var u uploadBody
	resp.decode(s.e.t, &u)
	return u
}

func (s sender) put(upload string, n int, frame []byte) response {
	s.e.t.Helper()
	return s.e.call(http.MethodPut, fmt.Sprintf("%s/public/requests/%s/uploads/%s/frames/%d", api, s.id, upload, n), string(frame),
		"X-Link-Token", s.token, "X-Content-SHA256", sumB64(frame), "Content-Type", "application/octet-stream")
}

// send runs a whole upload through the request.
func (s sender) send(frames [][]byte) uploadBody {
	s.e.t.Helper()
	u := s.start(frames)
	for i, f := range frames {
		s.put(u.ID, i, f).wantStatus(s.e.t, http.StatusNoContent)
	}
	s.post("/uploads/"+u.ID+"/commit", s.commitBody()).wantStatus(s.e.t, http.StatusNoContent)
	return u
}

func newSender(e *env, d *driveUser, id string) sender {
	e.t.Helper()
	return sender{e: e, d: d, id: id, token: openRequest(e, id).Token}
}

func (d *driveUser) incoming() []incomingBody {
	d.e.t.Helper()
	var page struct {
		Items []incomingBody `json:"items"`
	}
	resp := d.call(http.MethodGet, api+"/incoming", nil)
	resp.wantStatus(d.e.t, http.StatusOK)
	resp.decode(d.e.t, &page)
	return page.Items
}

func (d *driveUser) adoptBody(name string) obj {
	return obj{"parent_key_generation": 1, "wrapped_key": d.wrapped(), "name_tag": tagOf(name),
		"sealed_metadata": b64([]byte("sealed " + name)), "signature": d.signature(), "manifest": b64([]byte(`{"manifest":true}`))}
}

func TestRequestLifecycle(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		folder := alice.create(alice.root().ID, "folder", "inbox")
		l := alice.request(folder.ID, "file_limit", 5, "max_file_size", 100_000, "bytes_limit", 200_000)
		if l.Kind != "request" || l.Role != "" || l.SealedKey != "" || l.PublicKey != alice.publicKey() || l.FileLimit != 5 || l.MaxFileSize != 100_000 {
			t.Errorf("request %+v", l)
		}
		if !e.audited("link_created") {
			t.Error("no audit row")
		}

		doc := openRequest(e, l.ID)
		if doc.State != "open" || doc.Token == "" || doc.Node != nil || doc.Suite != alice.suite || doc.PublicKey == nil ||
			*doc.PublicKey != alice.publicKey() || *doc.FilesRemaining != 5 || *doc.BytesRemaining != 200_000 || *doc.MaxFileSize != 100_000 {
			t.Errorf("open %+v", doc)
		}
		// Each kind answers on its own routes only.
		e.call(http.MethodGet, api+"/public/links/"+l.ID, nil).wantError(t, http.StatusNotFound, "not_found")
		anon(e, http.MethodGet, "/public/links/"+l.ID+"/nodes/"+folder.ID+"/children", doc.Token).wantError(t, http.StatusNotFound, "not_found")
		view := alice.link(folder.ID)
		e.call(http.MethodGet, api+"/public/requests/"+view.ID, nil).wantError(t, http.StatusNotFound, "not_found")

		s := sender{e: e, d: alice, id: l.ID, token: doc.Token}
		frames := alice.frames(2500, 3)
		u := s.start(frames)
		resp := e.call(http.MethodGet, api+"/public/requests/"+l.ID+"/uploads/"+u.ID, nil, "X-Link-Token", s.token)
		resp.wantStatus(t, http.StatusOK)
		s.put(u.ID, 1, frames[1]).wantStatus(t, http.StatusNoContent)
		s.post("/uploads/"+u.ID+"/commit", s.commitBody()).wantError(t, http.StatusConflict, "upload_incomplete")
		var status uploadBody
		e.call(http.MethodGet, api+"/public/requests/"+l.ID+"/uploads/"+u.ID, nil, "X-Link-Token", s.token).decode(t, &status)
		if len(status.Frames) != 1 || status.Frames[0] != 1 {
			t.Errorf("frames %v", status.Frames)
		}
		if len(alice.incoming()) != 0 {
			t.Error("an item on its way is listed")
		}
		if _, reserved := alice.storage(); reserved != stored(frames) {
			t.Errorf("reserved %d", reserved)
		}
		s.put(u.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)
		s.put(u.ID, 2, frames[2]).wantStatus(t, http.StatusNoContent)
		resp = s.post("/uploads/"+u.ID+"/commit", s.commitBody())
		resp.wantStatus(t, http.StatusNoContent)
		if len(resp.body) != 0 || !e.audited("request_upload_received") {
			t.Errorf("commit said %q", resp.body)
		}
		// A lost answer can be retried, and is the same answer.
		s.post("/uploads/"+u.ID+"/commit", s.commitBody()).wantStatus(t, http.StatusNoContent)
		if used, reserved := alice.storage(); used != stored(frames) || reserved != 0 {
			t.Errorf("used %d, reserved %d", used, reserved)
		}

		items := alice.incoming()
		if len(items) != 1 || items[0].LinkID != l.ID || items[0].FolderID != folder.ID || items[0].Size != 2500 ||
			items[0].StoredSize != stored(frames) || items[0].SealedPrivateKey != alice.sealedKey() || items[0].PublicKey != alice.publicKey() ||
			items[0].BlobID != u.ID || items[0].SealedMetadata != b64([]byte("sealed name")) {
			t.Fatalf("incoming %+v", items)
		}
		var hashes bytes.Buffer
		for _, f := range frames {
			sum := sha256.Sum256(f)
			hashes.Write(sum[:])
		}
		if items[0].FrameHashes != b64(hashes.Bytes()) {
			t.Error("frame hashes")
		}
		if len(bob.incoming()) != 0 {
			t.Error("bob sees alice's items")
		}
		bob.call(http.MethodPost, api+"/incoming/"+items[0].ID+"/adopt", bob.adoptBody("x")).wantError(t, http.StatusNotFound, "not_found")
		bob.call(http.MethodDelete, api+"/incoming/"+items[0].ID, nil).wantError(t, http.StatusNotFound, "not_found")

		resp = alice.call(http.MethodPost, api+"/incoming/"+items[0].ID+"/adopt", alice.adoptBody("from someone"))
		resp.wantStatus(t, http.StatusCreated)
		var n nodeBody
		resp.decode(t, &n)
		if n.ID != items[0].ID || n.ParentID != folder.ID || n.CurrentVersion != items[0].VersionID || n.Kind != "file" || !e.audited("incoming_adopted") {
			t.Errorf("adopted %+v", n)
		}
		var v versionBody
		alice.call(http.MethodGet, api+"/nodes/"+n.ID+"/versions/"+n.CurrentVersion, nil).decode(t, &v)
		if v.BlobID != u.ID || v.AuthorID != alice.id || v.ContentAuthorID != alice.id || v.StoredSize != stored(frames) {
			t.Errorf("version %+v", v)
		}
		blob := alice.call(http.MethodGet, api+"/blobs/"+u.ID, nil)
		blob.wantStatus(t, http.StatusOK)
		if !bytes.Equal(blob.body, bytes.Join(frames, nil)) {
			t.Error("the frames changed on their way in")
		}
		if len(alice.incoming()) != 0 {
			t.Error("an adopted item is still listed")
		}
		var after requestLinkBody
		var page struct {
			Items []struct {
				Link requestLinkBody `json:"link"`
			} `json:"items"`
		}
		alice.call(http.MethodGet, api+"/links", nil).decode(t, &page)
		for _, item := range page.Items {
			if item.Link.ID == l.ID {
				after = item.Link
			}
		}
		if after.FilesReceived != 1 || after.BytesReceived != 2500 {
			t.Errorf("after %+v", after)
		}
		if doc := openRequest(e, l.ID); *doc.FilesRemaining != 4 || *doc.BytesRemaining != 200_000-2500 {
			t.Errorf("left %+v", doc)
		}
	})
}

func TestRequestLimitsStopUploads(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		folder := alice.create(alice.root().ID, "folder", "inbox")
		l := alice.request(folder.ID, "file_limit", 2, "max_file_size", 2000, "bytes_limit", 3000)
		s := newSender(e, alice, l.ID)

		s.post("/uploads", s.uploadRequest(alice.frames(2001, 1))).wantError(t, http.StatusRequestEntityTooLarge, "request_file_too_large")
		first := s.start(alice.frames(2000, 1))
		s.post("/uploads", s.uploadRequest(alice.frames(1001, 1))).wantError(t, http.StatusRequestEntityTooLarge, "request_bytes_reached")
		// An abandoned upload gives its room back.
		resp := e.call(http.MethodDelete, api+"/public/requests/"+l.ID+"/uploads/"+first.ID, nil, "X-Link-Token", s.token)
		resp.wantStatus(t, http.StatusNoContent)
		if _, reserved := alice.storage(); reserved != 0 {
			t.Errorf("reserved %d after the abort", reserved)
		}
		s.send(alice.frames(1500, 1))
		s.send(alice.frames(1500, 2))
		s.post("/uploads", s.uploadRequest(alice.frames(1, 1))).wantError(t, http.StatusConflict, "request_files_reached")

		// The owner's quota holds as well.
		admin := e.login("root")
		admin.call(http.MethodPatch, api+"/admin/users/"+alice.id, obj{"quota_bytes": 5000}).wantStatus(t, http.StatusOK)
		other := newSender(e, alice, alice.request(folder.ID).ID)
		other.post("/uploads", other.uploadRequest(alice.frames(4000, 1))).wantError(t, http.StatusRequestEntityTooLarge, "quota_exceeded")
	})
}

func TestRequestRefusals(t *testing.T) {
	e, alice, bob := driveEnv(t, "e2e")
	folder := alice.create(alice.root().ID, "folder", "inbox")
	file := alice.create(folder.ID, "file", "file")
	post := func(extra ...any) response {
		return alice.call(http.MethodPost, api+"/links", alice.requestRequest(folder.ID, extra...))
	}
	post("role", "view").wantError(t, http.StatusBadRequest, "invalid_link")
	post("sealed_key", alice.sealedKey()).wantError(t, http.StatusBadRequest, "invalid_link")
	post("public_key", b64(fill(1, 31))).wantError(t, http.StatusBadRequest, "invalid_link")
	post("public_key", nil).wantError(t, http.StatusBadRequest, "invalid_link")
	post("download_limit", 3).wantError(t, http.StatusBadRequest, "invalid_link")
	post("file_limit", 0).wantError(t, http.StatusBadRequest, "invalid_link")
	post("kind", "upload").wantError(t, http.StatusBadRequest, "invalid_link")
	post("password", alice.passwordFor("pw")).wantError(t, http.StatusBadRequest, "invalid_link")
	post("node_id", file.ID).wantError(t, http.StatusConflict, "not_a_folder")
	bob.call(http.MethodPost, api+"/links", bob.requestRequest(folder.ID)).wantError(t, http.StatusNotFound, "not_found")
	alice.call(http.MethodPost, api+"/links", alice.linkRequest(folder.ID, "max_file_size", 10)).wantError(t, http.StatusBadRequest, "invalid_link")

	l := alice.request(folder.ID)
	s := newSender(e, alice, l.ID)
	frames := alice.frames(100, 1)
	s.post("/uploads", s.uploadRequest(frames, "suite", "none")).wantError(t, http.StatusBadRequest, "suite_mismatch")
	s.post("/uploads", s.uploadRequest(frames, "stored_size", 5)).wantError(t, http.StatusBadRequest, "invalid_framing")
	// The server chooses the ids, so whatever a sender names, nothing tells it whether it exists.
	chosen := s.start(frames, "id", file.ID, "version_id", file.ID)
	if chosen.NodeID == "" || chosen.NodeID == file.ID || chosen.VersionID == file.ID || chosen.NodeID == folder.ID {
		t.Errorf("ids %+v", chosen)
	}
	e.call(http.MethodPost, api+"/public/requests/"+l.ID+"/uploads", s.uploadRequest(frames)).wantError(t, http.StatusUnauthorized, "link_token_required")
	view := alice.link(folder.ID)
	viewToken := openLink(e, view.ID).Token
	e.call(http.MethodPost, api+"/public/requests/"+l.ID+"/uploads", s.uploadRequest(frames), "X-Link-Token", viewToken).
		wantError(t, http.StatusUnauthorized, "link_token_invalid")

	// An upload through a request belongs to it alone: not to the owner's routes,
	// nor to another request.
	u := s.start(frames)
	if list := alice.call(http.MethodGet, api+"/uploads", nil); bytes.Contains(list.body, []byte(u.ID)) {
		t.Error("the owner lists an upload through a request")
	}
	alice.call(http.MethodGet, api+"/uploads/"+u.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	alice.put(u.ID, 0, frames[0]).wantError(t, http.StatusNotFound, "not_found")
	alice.call(http.MethodDelete, api+"/uploads/"+u.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	other := newSender(e, alice, alice.request(folder.ID).ID)
	other.put(u.ID, 0, frames[0]).wantError(t, http.StatusNotFound, "not_found")
	s.put(u.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)
	s.put(u.ID, 0, append([]byte{frames[0][0] + 1}, frames[0][1:]...)).wantError(t, http.StatusConflict, "frame_conflict")
	s.post("/uploads/"+u.ID+"/commit", s.commitBody("sealed_key", b64(fill(1, 73)))).wantError(t, http.StatusBadRequest, "invalid_node")
	s.post("/uploads/"+u.ID+"/commit", s.commitBody("sealed_metadata", b64(make([]byte, 8<<10+1)))).wantError(t, http.StatusBadRequest, "invalid_node")
	s.post("/uploads/"+u.ID+"/commit", s.commitBody("sealed_metadata", "")).wantError(t, http.StatusBadRequest, "invalid_node")
	other.post("/uploads/"+u.ID+"/commit", other.commitBody()).wantError(t, http.StatusNotFound, "not_found")
	s.post("/uploads/"+u.ID+"/commit", s.commitBody()).wantStatus(t, http.StatusNoContent)

	// What waits cannot be adopted wrong.
	item := alice.incoming()[0]
	adopt := func(extra ...any) response {
		body := alice.adoptBody("name")
		for i := 0; i+1 < len(extra); i += 2 {
			body[extra[i].(string)] = extra[i+1]
		}
		return alice.call(http.MethodPost, api+"/incoming/"+item.ID+"/adopt", body)
	}
	adopt("wrapped_key", "").wantError(t, http.StatusBadRequest, "keys_required")
	adopt("name_tag", b64(fill(1, 31))).wantError(t, http.StatusBadRequest, "invalid_node")
	adopt("signature", b64(fill(1, 63))).wantError(t, http.StatusBadRequest, "invalid_commit")
	adopt("parent_key_generation", 2).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")
	adopt("name_tag", tagOf("file")).wantError(t, http.StatusConflict, "name_conflict")
	alice.call(http.MethodPost, api+"/incoming/nope/adopt", alice.adoptBody("x")).wantError(t, http.StatusBadRequest, "invalid_id")
	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	adopt().wantError(t, http.StatusConflict, "parent_trashed")
	e.call(http.MethodGet, api+"/public/requests/"+l.ID, nil).wantError(t, http.StatusNotFound, "not_found")
}

func TestRequestBlobsFollowTheMode(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	folder := alice.create(alice.root().ID, "folder", "inbox")
	alice.call(http.MethodPost, api+"/links", alice.requestRequest(folder.ID, "public_key", b64(fill(1, 32)))).wantError(t, http.StatusBadRequest, "invalid_link")
	alice.call(http.MethodPost, api+"/links", alice.requestRequest(folder.ID, "owner_sealed_key", b64(fill(1, 73)))).wantError(t, http.StatusBadRequest, "invalid_link")
	s := newSender(e, alice, alice.request(folder.ID).ID)
	u := s.start(alice.frames(10, 1))
	s.put(u.ID, 0, alice.frames(10, 1)[0]).wantStatus(t, http.StatusNoContent)
	s.post("/uploads/"+u.ID+"/commit", s.commitBody("sealed_key", b64(fill(1, 105)))).wantError(t, http.StatusBadRequest, "invalid_node")
}

func TestRequestPassword(t *testing.T) {
	e, alice := limitedEnv(t, "e2e", 5)
	folder := alice.create(alice.root().ID, "folder", "inbox")
	l := alice.request(folder.ID, "password", obj{"kdf": kdf(7), "auth_key": b64(key("pw"))})
	doc := openRequest(e, l.ID)
	if doc.State != "password_required" || doc.KDF == nil || doc.Token != "" || doc.PublicKey != nil {
		t.Fatalf("locked %+v", doc)
	}
	unlock := func(label string) response {
		return e.call(http.MethodPost, api+"/public/requests/"+l.ID+"/unlock", obj{"auth_key": b64(key(label))})
	}
	unlock("wrong").wantError(t, http.StatusUnauthorized, "link_password_invalid")
	if !e.audited("link_unlock_failed") {
		t.Error("no audit row for the failure")
	}
	resp := unlock("pw")
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &doc)
	if doc.State != "open" || doc.Token == "" || *doc.PublicKey != alice.publicKey() {
		t.Fatalf("unlocked %+v", doc)
	}
	s := sender{e: e, d: alice, id: l.ID, token: doc.Token}
	s.send(alice.frames(10, 1))
	// The token renews without the password.
	if again := openRequest(e, l.ID, "X-Link-Token", doc.Token); again.State != "open" || again.Token == "" {
		t.Errorf("renewed %+v", again)
	}
	for range 5 {
		unlock("wrong")
	}
	unlock("pw").wantError(t, http.StatusTooManyRequests, "rate_limited")
}

func TestStartingUploadsThroughARequestIsLimited(t *testing.T) {
	e, alice := limitedEnv(t, "none", 3)
	folder := alice.create(alice.root().ID, "folder", "inbox")
	s := newSender(e, alice, alice.request(folder.ID).ID)
	limited := false
	for range 40 {
		resp := s.post("/uploads", s.uploadRequest(alice.frames(10, 1)))
		if resp.status == http.StatusTooManyRequests {
			limited = true
			break
		}
		var u uploadBody
		resp.decode(t, &u)
		e.call(http.MethodDelete, api+"/public/requests/"+s.id+"/uploads/"+u.ID, nil, "X-Link-Token", s.token).wantStatus(t, http.StatusNoContent)
	}
	if !limited {
		t.Error("no limit on starting uploads")
	}
}

func TestARequestTakesALargeFrame(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	folder := alice.create(alice.root().ID, "folder", "inbox")
	s := newSender(e, alice, alice.request(folder.ID).ID)
	frame := bytes.Repeat([]byte{7}, 2<<20)
	u := s.start([][]byte{frame}, "frame_size", 2<<20)
	s.put(u.ID, 0, frame).wantStatus(t, http.StatusNoContent)
}

func TestIncomingEndsWithItsRequest(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		folder := alice.create(alice.root().ID, "folder", "inbox")

		// Deleted by its owner: its bytes go, and its place on the request stays taken.
		l := alice.request(folder.ID, "file_limit", 1)
		s := newSender(e, alice, l.ID)
		u := s.send(alice.frames(100, 1))
		item := alice.incoming()[0]
		alice.call(http.MethodDelete, api+"/incoming/"+item.ID, nil).wantStatus(t, http.StatusNoContent)
		if !e.audited("incoming_deleted") || exists(e.blobFile(u.ID)) {
			t.Error("the item is not gone")
		}
		if used, _ := alice.storage(); used != 0 {
			t.Errorf("used %d", used)
		}
		s.post("/uploads", s.uploadRequest(alice.frames(10, 1))).wantError(t, http.StatusConflict, "request_files_reached")

		// Revoked: nothing more comes in, what came is adopted until the purge.
		revoked := alice.request(folder.ID)
		s = newSender(e, alice, revoked.ID)
		s.send(alice.frames(100, 2))
		s.send(alice.frames(100, 3))
		pending := s.start(alice.frames(100, 4))
		alice.call(http.MethodPost, api+"/links/"+revoked.ID+"/revoke", nil).wantStatus(t, http.StatusOK)
		s.post("/uploads", s.uploadRequest(alice.frames(10, 1))).wantError(t, http.StatusGone, "link_revoked")
		s.put(pending.ID, 0, alice.frames(100, 4)[0]).wantError(t, http.StatusGone, "link_revoked")
		items := alice.incoming()
		if len(items) != 2 {
			t.Fatalf("items %+v", items)
		}
		alice.call(http.MethodPost, api+"/incoming/"+items[0].ID+"/adopt", alice.adoptBody("kept")).wantStatus(t, http.StatusCreated)

		e.advance(29 * day)
		if err := e.srv.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		if len(alice.incoming()) != 1 {
			t.Error("purged before the grace period was over")
		}
		e.advance(2 * day)
		if err := e.srv.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		if len(alice.incoming()) != 0 || exists(e.blobFile(items[1].BlobID)) {
			t.Error("not purged after the grace period")
		}
		alice.get(items[0].ID)
		if used, reserved := alice.storage(); used != stored(alice.frames(100, 2)) || reserved != 0 {
			t.Errorf("used %d, reserved %d", used, reserved)
		}

		// Deleted: what waits goes with the key that opens it.
		gone := alice.request(folder.ID)
		newSender(e, alice, gone.ID).send(alice.frames(100, 5))
		alice.call(http.MethodDelete, api+"/links/"+gone.ID, nil).wantStatus(t, http.StatusNoContent)
		if len(alice.incoming()) != 0 {
			t.Error("items outlived their request")
		}
	})
}

// limitedEnv is driveEnv with a sign-in limit low enough to reach.
func limitedEnv(t *testing.T, mode string, attempts int) (*env, *driveUser) {
	t.Helper()
	e := configured(t, mode, server.Config{LoginAttempts: attempts})
	admin := e.login("root")
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"default_quota_bytes": 0}).wantStatus(t, http.StatusOK)
	return e, newDriveUser(e, admin, "alice", mode)
}

func TestARequestHoldsAtMostTwentyUploadsAndDropsIdleOnes(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	folder := alice.create(alice.root().ID, "folder", "inbox")
	l := alice.request(folder.ID)
	s := newSender(e, alice, l.ID)
	var first uploadBody
	for i := range 20 {
		u := s.start(alice.frames(10, 1))
		if i == 0 {
			first = u
		}
	}
	s.post("/uploads", s.uploadRequest(alice.frames(10, 1))).wantError(t, http.StatusConflict, "too_many_uploads")
	var page struct {
		Items []struct {
			Link struct {
				ID                string `json:"id"`
				UploadsInProgress int64  `json:"uploads_in_progress"`
			} `json:"link"`
		} `json:"items"`
	}
	alice.call(http.MethodGet, api+"/links", nil).decode(t, &page)
	if len(page.Items) != 1 || page.Items[0].Link.UploadsInProgress != 20 {
		t.Errorf("links %+v", page.Items)
	}

	// A frame keeps an upload going; an hour without one drops it, and its place comes back.
	e.advance(50 * time.Minute)
	s = newSender(e, alice, l.ID)
	s.put(first.ID, 0, alice.frames(10, 1)[0]).wantStatus(t, http.StatusNoContent)
	e.advance(20 * time.Minute)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	s = newSender(e, alice, l.ID)
	resp := e.call(http.MethodGet, api+"/public/requests/"+l.ID+"/uploads/"+first.ID, nil, "X-Link-Token", s.token)
	resp.wantStatus(t, http.StatusOK)
	alice.call(http.MethodGet, api+"/links", nil).decode(t, &page)
	if page.Items[0].Link.UploadsInProgress != 1 {
		t.Errorf("after the sweep %+v", page.Items)
	}
	if _, reserved := alice.storage(); reserved != stored(alice.frames(10, 1)) {
		t.Errorf("reserved %d", reserved)
	}
	s.start(alice.frames(10, 1))
}

func TestDeletingARequestFreesItsFiles(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	folder := alice.create(alice.root().ID, "folder", "inbox")
	l := alice.request(folder.ID)
	u := newSender(e, alice, l.ID).send(alice.frames(100, 1))
	if !exists(e.blobFile(u.ID)) {
		t.Fatal("no file")
	}
	alice.call(http.MethodDelete, api+"/links/"+l.ID, nil).wantStatus(t, http.StatusNoContent)
	if exists(e.blobFile(u.ID)) {
		t.Error("the file outlived its request")
	}
	if used, _ := alice.storage(); used != 0 {
		t.Errorf("used %d", used)
	}
}
