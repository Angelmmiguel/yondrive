package server_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

const (
	e2eSuite  = "xchacha20poly1305-v1"
	noneSuite = "none"
	api       = "/api/v1"
	day       = 24 * time.Hour
)

// driveUser is a signed-in user on a configured server, in either mode.
type driveUser struct {
	*client
	id    string
	mode  string
	suite string
}

func newDriveUser(e *env, admin *client, name, mode string) *driveUser {
	e.t.Helper()
	id := e.register(admin, name, mode)
	return asDriveUser(e, e.login(name), id, mode)
}

func asDriveUser(_ *env, c *client, id, mode string) *driveUser {
	suite := noneSuite
	if mode == "e2e" {
		suite = e2eSuite
	}
	return &driveUser{client: c, id: id, mode: mode, suite: suite}
}

// driveEnv returns a server with two users on an unlimited quota, unless the
// default quota is set otherwise.
func driveEnv(t *testing.T, mode string) (*env, *driveUser, *driveUser) {
	t.Helper()
	// The sessions outlive the months these tests skip through.
	e := configured(t, mode, server.Config{SessionTTL: 3650 * day, SessionMaxAge: 3650 * day})
	admin := e.login("root")
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"default_quota_bytes": 0}).wantStatus(t, http.StatusOK)
	return e, newDriveUser(e, admin, "alice", mode), newDriveUser(e, admin, "bob", mode)
}

func (d *driveUser) wrapped() string {
	if d.mode == "e2e" {
		return b64(fill(7, 73))
	}
	return ""
}

func (d *driveUser) signature() string {
	if d.mode == "e2e" {
		return b64(fill(9, 64))
	}
	return ""
}

type nodeBody struct {
	ID             string  `json:"id"`
	ParentID       string  `json:"parent_id"`
	Kind           string  `json:"kind"`
	Suite          string  `json:"suite"`
	OwnerID        string  `json:"owner_id"`
	SealedMetadata string  `json:"sealed_metadata"`
	WrappedKey     *string `json:"wrapped_key"`
	NameTag        string  `json:"name_tag"`
	CurrentVersion string  `json:"current_version"`
	ThumbBlobID    string  `json:"thumb_blob_id"`
	TrashedAt      string  `json:"trashed_at"`
	PurgedAt       string  `json:"purged_at"`
	RemoveAt       string  `json:"remove_at"`
}

type pageBody struct {
	Nodes      []nodeBody `json:"nodes"`
	NextCursor string     `json:"next_cursor"`
}

func (d *driveUser) root() nodeBody {
	d.e.t.Helper()
	resp := d.call(http.MethodPost, api+"/nodes/root", obj{"id": store.NewID(), "suite": d.suite, "wrapped_key": d.wrapped()})
	if resp.status != http.StatusCreated && resp.status != http.StatusOK {
		d.e.t.Fatalf("root: %d %s", resp.status, resp.body)
	}
	var n nodeBody
	resp.decode(d.e.t, &n)
	return n
}

func tagOf(name string) string {
	sum := sha256.Sum256([]byte(name))
	return b64(sum[:])
}

func (d *driveUser) nodeRequest(parent, kind, name string) obj {
	return obj{
		"id": store.NewID(), "parent_id": parent, "kind": kind, "suite": d.suite,
		"sealed_metadata": b64([]byte("sealed " + name)), "wrapped_key": d.wrapped(), "name_tag": tagOf(name),
	}
}

func (d *driveUser) create(parent, kind, name string) nodeBody {
	d.e.t.Helper()
	resp := d.call(http.MethodPost, api+"/nodes", d.nodeRequest(parent, kind, name))
	resp.wantStatus(d.e.t, http.StatusCreated)
	var n nodeBody
	resp.decode(d.e.t, &n)
	return n
}

func (d *driveUser) get(id string) nodeBody {
	d.e.t.Helper()
	resp := d.call(http.MethodGet, api+"/nodes/"+id, nil)
	resp.wantStatus(d.e.t, http.StatusOK)
	var n nodeBody
	resp.decode(d.e.t, &n)
	return n
}

type uploadBody struct {
	ID         string  `json:"id"`
	VersionID  string  `json:"version_id"`
	FrameCount int64   `json:"frame_count"`
	FrameSize  int64   `json:"frame_size"`
	StoredSize int64   `json:"stored_size"`
	Frames     []int64 `json:"frames"`
}

type versionBody struct {
	ID               string  `json:"id"`
	BlobID           string  `json:"blob_id"`
	Suite            string  `json:"suite"`
	AuthorID         string  `json:"author_id"`
	ContentVersionID string  `json:"content_version_id"`
	ContentAuthorID  string  `json:"content_author_id"`
	StoredSize       int64   `json:"stored_size"`
	FrameCount       int64   `json:"frame_count"`
	FrameSize        int64   `json:"frame_size"`
	FrameHashes      string  `json:"frame_hashes"`
	Signature        *string `json:"signature"`
	Manifest         string  `json:"manifest"`
	DeletedAt        string  `json:"deleted_at"`
	RemoveAt         string  `json:"remove_at"`
}

const testFrameSize = 1024

// overhead is what sealing adds to each stored frame.
func (d *driveUser) overhead() int {
	if d.mode == "e2e" {
		return 41
	}
	return 0
}

// frames makes the stored frames of a file of size bytes.
func (d *driveUser) frames(size int, seed byte) [][]byte {
	stride := testFrameSize + d.overhead()
	if size == 0 {
		return [][]byte{make([]byte, d.overhead())}
	}
	var out [][]byte
	for offset := 0; offset < size; offset += testFrameSize {
		n := min(testFrameSize, size-offset)
		frame := make([]byte, n+d.overhead())
		for i := range frame {
			frame[i] = seed + byte(offset/testFrameSize) + byte(i)
		}
		out = append(out, frame[:min(len(frame), stride)])
	}
	return out
}

func stored(frames [][]byte) int64 {
	var total int64
	for _, f := range frames {
		total += int64(len(f))
	}
	return total
}

func (d *driveUser) startUpload(node string, frames [][]byte) uploadBody {
	d.e.t.Helper()
	resp := d.call(http.MethodPost, api+"/uploads", d.uploadRequest(node, frames))
	resp.wantStatus(d.e.t, http.StatusCreated)
	var u uploadBody
	resp.decode(d.e.t, &u)
	return u
}

func (d *driveUser) uploadRequest(node string, frames [][]byte) obj {
	return obj{
		"node_id": node, "version_id": store.NewID(), "suite": d.suite,
		"frame_count": len(frames), "frame_size": testFrameSize, "stored_size": stored(frames),
	}
}

func sumB64(b []byte) string {
	sum := sha256.Sum256(b)
	return b64(sum[:])
}

func (d *driveUser) put(upload string, n int, frame []byte) response {
	d.e.t.Helper()
	return d.e.call(http.MethodPut, fmt.Sprintf("%s/uploads/%s/frames/%d", api, upload, n), string(frame),
		"Cookie", d.cookie, "X-Content-SHA256", sumB64(frame), "Content-Type", "application/octet-stream")
}

func (d *driveUser) commitBody(expected ...string) obj {
	body := obj{"signature": d.signature(), "manifest": b64([]byte(`{"manifest":true}`))}
	if len(expected) == 1 {
		body["expected_version"] = expected[0]
	}
	return body
}

// upload runs a whole upload and returns the version.
func (d *driveUser) upload(node string, frames [][]byte) versionBody {
	d.e.t.Helper()
	u := d.startUpload(node, frames)
	for i, f := range frames {
		d.put(u.ID, i, f).wantStatus(d.e.t, http.StatusNoContent)
	}
	resp := d.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", d.commitBody())
	resp.wantStatus(d.e.t, http.StatusCreated)
	var v versionBody
	resp.decode(d.e.t, &v)
	return v
}

func (d *driveUser) storage() (used, reserved int64) {
	d.e.t.Helper()
	var s struct {
		Used     int64 `json:"used_bytes"`
		Reserved int64 `json:"reserved_bytes"`
	}
	resp := d.call(http.MethodGet, api+"/me/storage", nil)
	resp.wantStatus(d.e.t, http.StatusOK)
	resp.decode(d.e.t, &s)
	return s.Used, s.Reserved
}

func (e *env) blobFile(id string) string {
	return filepath.Join(e.st.Dir(), "blobs", id[:2], id)
}

func (e *env) uploadFile(id string) string {
	return filepath.Join(e.st.Dir(), "uploads", id)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func eachMode(t *testing.T, fn func(t *testing.T, mode string)) {
	t.Helper()
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) { fn(t, mode) })
	}
}

func TestRootIsCreatedOnDemand(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, _ := driveEnv(t, mode)
		alice.call(http.MethodGet, api+"/nodes/root", nil).wantError(t, http.StatusNotFound, "not_found")

		id := store.NewID()
		resp := alice.call(http.MethodPost, api+"/nodes/root", obj{"id": id, "suite": alice.suite, "wrapped_key": alice.wrapped()})
		resp.wantStatus(t, http.StatusCreated)
		var first nodeBody
		resp.decode(t, &first)
		if first.ID != id || first.Kind != "folder" || first.Suite != alice.suite || first.OwnerID != alice.id || first.ParentID != "" {
			t.Errorf("root = %+v", first)
		}
		if first.WrappedKey == nil || (mode == "none" && *first.WrappedKey != "") {
			t.Errorf("wrapped key = %v", first.WrappedKey)
		}

		// A second device gets the first device's root, and must use it.
		resp = alice.call(http.MethodPost, api+"/nodes/root", obj{"id": store.NewID(), "suite": alice.suite, "wrapped_key": alice.wrapped()})
		resp.wantStatus(t, http.StatusOK)
		var again nodeBody
		resp.decode(t, &again)
		if again.ID != id {
			t.Errorf("second root = %s, want %s", again.ID, id)
		}
		var got nodeBody
		resp = alice.call(http.MethodGet, api+"/nodes/root", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &got)
		if got.ID != id {
			t.Errorf("root = %s", got.ID)
		}
	})
}

func TestSuiteMustMatchTheMode(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, _ := driveEnv(t, mode)
		wrong := e2eSuite
		if mode == "e2e" {
			wrong = noneSuite
		}
		for _, suite := range []string{wrong, "rot13", ""} {
			alice.call(http.MethodPost, api+"/nodes/root", obj{"id": store.NewID(), "suite": suite, "wrapped_key": alice.wrapped()}).
				wantError(t, http.StatusBadRequest, "suite_mismatch")
		}
		root := alice.root()
		body := alice.nodeRequest(root.ID, "file", "a")
		body["suite"] = wrong
		alice.call(http.MethodPost, api+"/nodes", body).wantError(t, http.StatusBadRequest, "suite_mismatch")

		f := alice.create(root.ID, "file", "a")
		alice.call(http.MethodPatch, api+"/nodes/"+f.ID, obj{"suite": wrong}).wantError(t, http.StatusBadRequest, "suite_mismatch")
		frames := alice.frames(10, 1)
		req := alice.uploadRequest(f.ID, frames)
		req["suite"] = wrong
		alice.call(http.MethodPost, api+"/uploads", req).wantError(t, http.StatusBadRequest, "suite_mismatch")
		alice.e.call(http.MethodPut, api+"/blobs/"+store.NewID()+"?kind=index&suite="+url.QueryEscape(wrong), "x",
			"Cookie", alice.cookie, "X-Content-SHA256", sumB64([]byte("x"))).wantError(t, http.StatusBadRequest, "suite_mismatch")
	})
}

func TestWrappedKeyFollowsTheMode(t *testing.T) {
	t.Run("e2e", func(t *testing.T) {
		_, alice, _ := driveEnv(t, "e2e")
		alice.call(http.MethodPost, api+"/nodes/root", obj{"id": store.NewID(), "suite": e2eSuite, "wrapped_key": ""}).
			wantError(t, http.StatusBadRequest, "keys_required")
		alice.call(http.MethodPost, api+"/nodes/root", obj{"id": store.NewID(), "suite": e2eSuite, "wrapped_key": b64(fill(1, 4))}).
			wantError(t, http.StatusBadRequest, "invalid_node")
	})
	t.Run("none", func(t *testing.T) {
		_, alice, _ := driveEnv(t, "none")
		alice.call(http.MethodPost, api+"/nodes/root", obj{"id": store.NewID(), "suite": noneSuite, "wrapped_key": b64(fill(1, 73))}).
			wantError(t, http.StatusBadRequest, "keys_not_allowed")
	})
}

func TestCreateListGetUpdateNodes(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, _ := driveEnv(t, mode)
		root := alice.root()
		folder := alice.create(root.ID, "folder", "docs")
		file := alice.create(folder.ID, "file", "a.txt")
		if file.ParentID != folder.ID || file.Kind != "file" || file.OwnerID != alice.id || file.CurrentVersion != "" {
			t.Errorf("file = %+v", file)
		}
		if got := alice.get(file.ID); got.SealedMetadata != b64([]byte("sealed a.txt")) || got.NameTag != tagOf("a.txt") {
			t.Errorf("get = %+v", got)
		}

		// The name tag is unique among siblings, and only those.
		alice.call(http.MethodPost, api+"/nodes", alice.nodeRequest(folder.ID, "folder", "a.txt")).wantError(t, http.StatusConflict, "name_conflict")
		alice.create(root.ID, "file", "a.txt")

		dup := alice.nodeRequest(folder.ID, "file", "other")
		dup["id"] = file.ID
		alice.call(http.MethodPost, api+"/nodes", dup).wantError(t, http.StatusConflict, "id_taken")

		under := alice.nodeRequest(file.ID, "file", "x")
		alice.call(http.MethodPost, api+"/nodes", under).wantError(t, http.StatusConflict, "not_a_folder")

		for name, change := range map[string]obj{
			"bad tag":        {"name_tag": b64(fill(1, 31))},
			"empty metadata": {"sealed_metadata": ""},
			"big metadata":   {"sealed_metadata": b64(fill(1, 64<<10+1))},
			"bad kind":       {"kind": "symlink"},
		} {
			body := alice.nodeRequest(folder.ID, "file", "y")
			for k, v := range change {
				body[k] = v
			}
			alice.call(http.MethodPost, api+"/nodes", body).wantError(t, http.StatusBadRequest, "invalid_node")
			if t.Failed() {
				t.Fatal(name)
			}
		}

		// A rename checks the new tag, and may keep its own.
		other := alice.create(folder.ID, "file", "b.txt")
		alice.call(http.MethodPatch, api+"/nodes/"+other.ID, obj{"suite": alice.suite, "name_tag": tagOf("a.txt")}).wantError(t, http.StatusConflict, "name_conflict")
		resp := alice.call(http.MethodPatch, api+"/nodes/"+other.ID, obj{"suite": alice.suite, "name_tag": tagOf("b.txt"), "sealed_metadata": b64([]byte("new"))})
		resp.wantStatus(t, http.StatusOK)
		if got := alice.get(other.ID); got.SealedMetadata != b64([]byte("new")) {
			t.Errorf("after update = %+v", got)
		}
		alice.call(http.MethodPatch, api+"/nodes/"+root.ID, obj{"suite": alice.suite, "name_tag": tagOf("x")}).wantError(t, http.StatusConflict, "root_immutable")
		alice.call(http.MethodPatch, api+"/nodes/"+other.ID, obj{"suite": alice.suite, "name_tag": b64(fill(1, 3))}).wantError(t, http.StatusBadRequest, "invalid_node")
		alice.call(http.MethodPatch, api+"/nodes/"+other.ID, obj{"suite": alice.suite, "sealed_metadata": ""}).wantError(t, http.StatusBadRequest, "invalid_node")
	})
}

func TestChildrenPagesAndCaps(t *testing.T) {
	_, alice, _ := driveEnv(t, "none")
	root := alice.root()
	const total = 5
	want := []string{}
	for i := range total {
		want = append(want, alice.create(root.ID, "file", fmt.Sprint(i)).ID)
	}
	slices.Sort(want)
	var got []string
	cursor := ""
	for range total + 1 {
		path := api + "/nodes/" + root.ID + "/children?limit=2"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		resp := alice.call(http.MethodGet, path, nil)
		resp.wantStatus(t, http.StatusOK)
		var p pageBody
		resp.decode(t, &p)
		for _, n := range p.Nodes {
			got = append(got, n.ID)
		}
		cursor = p.NextCursor
		if cursor == "" {
			break
		}
	}
	if !slices.Equal(got, want) {
		t.Errorf("children = %v, want %v", got, want)
	}
	// Anything above the cap is the cap; nothing below 1 is allowed.
	alice.call(http.MethodGet, api+"/nodes/"+root.ID+"/children?limit=1000000", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodGet, api+"/nodes/"+root.ID+"/children?limit=0", nil).wantError(t, http.StatusBadRequest, "bad_request")
	alice.call(http.MethodGet, api+"/nodes/"+root.ID+"/children?cursor=nope", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
	alice.call(http.MethodGet, api+"/trash?cursor=nope", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
	alice.call(http.MethodGet, api+"/me/index?cursor=nope", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
	alice.call(http.MethodGet, api+"/nodes/"+root.ID+"/versions?cursor=nope", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
	alice.call(http.MethodGet, api+"/changes?cursor=nope", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
	alice.call(http.MethodGet, api+"/changes?cursor=-1", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
}

func TestMoves(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, _ := driveEnv(t, mode)
		root := alice.root()
		a := alice.create(root.ID, "folder", "a")
		b := alice.create(a.ID, "folder", "b")
		f := alice.create(root.ID, "file", "f")
		alice.create(b.ID, "file", "taken")

		move := func(id, parent, name string) response {
			key := alice.wrapped()
			if mode == "e2e" {
				key = b64(fill(8, 73))
			}
			return alice.call(http.MethodPost, api+"/nodes/"+id+"/move", obj{"parent_id": parent, "wrapped_key": key, "name_tag": tagOf(name)})
		}
		move(a.ID, a.ID, "x").wantError(t, http.StatusConflict, "move_cycle")
		move(a.ID, b.ID, "x").wantError(t, http.StatusConflict, "move_cycle")
		move(root.ID, a.ID, "x").wantError(t, http.StatusConflict, "root_immutable")
		move(a.ID, f.ID, "x").wantError(t, http.StatusConflict, "not_a_folder")
		move(f.ID, b.ID, "taken").wantError(t, http.StatusConflict, "name_conflict")
		alice.call(http.MethodPost, api+"/nodes/"+f.ID+"/move", obj{"parent_id": b.ID, "wrapped_key": alice.wrapped(), "name_tag": b64(fill(1, 2))}).
			wantError(t, http.StatusBadRequest, "invalid_node")

		// A failed move left the old key alone.
		if got := alice.get(f.ID); got.ParentID != root.ID || *got.WrappedKey != alice.wrapped() {
			t.Errorf("after refused moves = %+v", got)
		}
		move(f.ID, b.ID, "moved").wantStatus(t, http.StatusOK)
		got := alice.get(f.ID)
		if got.ParentID != b.ID || got.NameTag != tagOf("moved") {
			t.Errorf("after the move = %+v", got)
		}
		if mode == "e2e" && *got.WrappedKey != b64(fill(8, 73)) {
			t.Errorf("wrapped key was not replaced: %v", *got.WrappedKey)
		}
	})
}

func TestUsersCannotReachEachOther(t *testing.T) {
	e, alice, bob := driveEnv(t, "none")
	root := alice.root()
	bobRoot := bob.root()
	folder := alice.create(root.ID, "folder", "d")
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(10, 1)
	v := alice.upload(file.ID, frames)
	open := alice.startUpload(file.ID, frames)
	trashed := alice.create(root.ID, "file", "t")
	alice.call(http.MethodPost, api+"/nodes/"+trashed.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	index := store.NewID()
	alice.e.call(http.MethodPut, api+"/blobs/"+index+"?kind=index&suite=none", "x",
		"Cookie", alice.cookie, "X-Content-SHA256", sumB64([]byte("x"))).wantStatus(t, http.StatusCreated)

	frame := string(frames[0])
	hash := []string{"X-Content-SHA256", sumB64(frames[0])}
	cases := []struct {
		method, path string
		body         any
		header       []string
	}{
		{http.MethodGet, "/nodes/" + file.ID, nil, nil},
		{http.MethodPatch, "/nodes/" + file.ID, obj{"suite": noneSuite, "sealed_metadata": b64([]byte("x"))}, nil},
		{http.MethodGet, "/nodes/" + folder.ID + "/children", nil, nil},
		{http.MethodPost, "/nodes", bob.nodeRequest(folder.ID, "file", "x"), nil},
		{http.MethodPost, "/nodes/" + file.ID + "/move", obj{"parent_id": bobRoot.ID, "wrapped_key": "", "name_tag": tagOf("x")}, nil},
		{http.MethodPost, "/nodes/" + file.ID + "/trash", nil, nil},
		{http.MethodPost, "/nodes/" + trashed.ID + "/restore", nil, nil},
		{http.MethodPost, "/nodes/" + trashed.ID + "/purge", nil, nil},
		{http.MethodGet, "/nodes/" + file.ID + "/versions", nil, nil},
		{http.MethodGet, "/nodes/" + file.ID + "/versions/" + v.ID, nil, nil},
		{http.MethodDelete, "/nodes/" + file.ID + "/versions/" + v.ID, nil, nil},
		{http.MethodPost, "/nodes/" + file.ID + "/versions/" + v.ID + "/restore", obj{"version_id": store.NewID()}, nil},
		{http.MethodPost, "/uploads", bob.uploadRequest(file.ID, frames), nil},
		{http.MethodGet, "/uploads/" + open.ID, nil, nil},
		{http.MethodPut, "/uploads/" + open.ID + "/frames/0", frame, hash},
		{http.MethodPost, "/uploads/" + open.ID + "/commit", bob.commitBody(), nil},
		{http.MethodDelete, "/uploads/" + open.ID, nil, nil},
		{http.MethodGet, "/blobs/" + v.BlobID, nil, nil},
		{http.MethodGet, "/blobs/" + index, nil, nil},
		{http.MethodDelete, "/blobs/" + index, nil, nil},
		{http.MethodPut, "/blobs/" + store.NewID() + "?kind=thumb&suite=none&node_id=" + file.ID, "x", []string{"X-Content-SHA256", sumB64([]byte("x"))}},
	}
	for _, c := range cases {
		header := append([]string{"Cookie", bob.cookie}, c.header...)
		resp := e.call(c.method, api+c.path, c.body, header...)
		if resp.status != http.StatusNotFound || resp.code() != "not_found" {
			t.Errorf("%s %s as bob: %d %s", c.method, c.path, resp.status, resp.body)
		}
		// Nobody signed in learns even less.
		resp = e.call(c.method, api+c.path, c.body, c.header...)
		if resp.status != http.StatusUnauthorized {
			t.Errorf("%s %s with no session: %d %s", c.method, c.path, resp.status, resp.body)
		}
	}
	// And a move into a stranger's folder from a node of one's own.
	own := bob.create(bobRoot.ID, "file", "mine")
	bob.call(http.MethodPost, api+"/nodes/"+own.ID+"/move", obj{"parent_id": folder.ID, "wrapped_key": "", "name_tag": tagOf("x")}).
		wantError(t, http.StatusNotFound, "not_found")

	// None of the above touched anything, and Bob's lists are his own.
	if got := alice.get(file.ID); got.TrashedAt != "" || got.SealedMetadata != b64([]byte("sealed f")) {
		t.Errorf("file = %+v", got)
	}
	alice.call(http.MethodGet, api+"/uploads/"+open.ID, nil).wantStatus(t, http.StatusOK)
	var p pageBody
	resp := bob.call(http.MethodGet, api+"/trash", nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &p)
	if len(p.Nodes) != 0 {
		t.Errorf("bob's trash = %+v", p.Nodes)
	}
	var idx struct {
		Blobs []any `json:"blobs"`
	}
	resp = bob.call(http.MethodGet, api+"/me/index", nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &idx)
	if len(idx.Blobs) != 0 {
		t.Errorf("bob's index = %+v", idx.Blobs)
	}
}

func TestIDsAreValidatedBeforeAnyPath(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	root := alice.root()
	// A file the traversal would reach, if it were ever joined to a path.
	secret := filepath.Join(e.st.Dir(), "yondrive.db")
	before, err := os.ReadFile(secret)
	if err != nil {
		t.Fatal(err)
	}
	bad := []string{
		"..%2F..%2Fyondrive.db", "..%2f..%2f..%2f..%2fetc%2fpasswd", "%2e%2e%2fyondrive.db", "..%5c..%5cyondrive.db",
		strings.Repeat("a", 31), strings.Repeat("a", 33), strings.Repeat("A", 32), strings.Repeat("g", 32),
		strings.Repeat("a", 31) + "%00",
	}
	for _, id := range bad {
		hash := []string{"Cookie", alice.cookie, "X-Content-SHA256", sumB64([]byte("x"))}
		for _, c := range []struct {
			method, path string
			body         any
		}{
			{http.MethodGet, "/nodes/" + id, nil},
			{http.MethodGet, "/blobs/" + id, nil},
			{http.MethodDelete, "/blobs/" + id, nil},
			{http.MethodPut, "/blobs/" + id + "?kind=index&suite=none", "x"},
			{http.MethodGet, "/uploads/" + id, nil},
			{http.MethodDelete, "/uploads/" + id, nil},
			{http.MethodPut, "/uploads/" + id + "/frames/0", "x"},
			{http.MethodPost, "/uploads/" + id + "/commit", alice.commitBody()},
			{http.MethodGet, "/nodes/" + root.ID + "/versions/" + id, nil},
			{http.MethodDelete, "/nodes/" + root.ID + "/versions/" + id, nil},
			{http.MethodPost, "/nodes/" + root.ID + "/versions/" + id + "/restore", obj{"version_id": store.NewID()}},
		} {
			resp := e.call(c.method, api+c.path, c.body, hash...)
			if resp.status != http.StatusBadRequest || (resp.code() != "invalid_id" && resp.code() != "bad_request") {
				t.Errorf("%s %s: %d %s", c.method, c.path, resp.status, resp.body)
			}
		}
	}
	// Ids in bodies and queries, decoded, get the same check.
	for _, id := range []string{"../../yondrive.db", "../" + strings.Repeat("a", 29), strings.Repeat("A", 32), ""} {
		node := alice.nodeRequest(root.ID, "file", "x")
		node["id"] = id
		alice.call(http.MethodPost, api+"/nodes", node).wantError(t, http.StatusBadRequest, "invalid_id")
		alice.call(http.MethodPost, api+"/nodes/root", obj{"id": id, "suite": alice.suite, "wrapped_key": ""}).wantError(t, http.StatusBadRequest, "invalid_id")
		node = alice.nodeRequest(id, "file", "x")
		alice.call(http.MethodPost, api+"/nodes", node).wantError(t, http.StatusBadRequest, "invalid_id")
		frames := alice.frames(1, 1)
		up := alice.uploadRequest(root.ID, frames)
		up["version_id"] = id
		alice.call(http.MethodPost, api+"/uploads", up).wantError(t, http.StatusBadRequest, "invalid_id")
		up = alice.uploadRequest(id, frames)
		alice.call(http.MethodPost, api+"/uploads", up).wantError(t, http.StatusBadRequest, "invalid_id")
		alice.e.call(http.MethodPut, api+"/blobs/"+store.NewID()+"?kind=thumb&suite=none&node_id="+url.QueryEscape(id), "x",
			"Cookie", alice.cookie, "X-Content-SHA256", sumB64([]byte("x"))).wantError(t, http.StatusBadRequest, "invalid_id")
	}
	after, err := os.ReadFile(secret)
	if err != nil || len(after) < len(before)/2 {
		t.Errorf("database after the attempts: %d bytes, %v", len(after), err)
	}
}

func TestUploadFramesInAnyOrderAndDownload(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		root := alice.root()
		file := alice.create(root.ID, "file", "f")
		frames := alice.frames(3*testFrameSize+100, 1)
		if len(frames) != 4 {
			t.Fatalf("%d frames", len(frames))
		}
		u := alice.startUpload(file.ID, frames)
		if used, reserved := alice.storage(); used != 0 || reserved != stored(frames) {
			t.Errorf("after create: used %d reserved %d", used, reserved)
		}
		var wg sync.WaitGroup
		for _, i := range []int{3, 0, 2, 1} {
			wg.Go(func() {
				resp := alice.put(u.ID, i, frames[i])
				if resp.status != http.StatusNoContent {
					t.Errorf("frame %d: %d %s", i, resp.status, resp.body)
				}
			})
		}
		wg.Wait()
		resp := alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody(""))
		resp.wantStatus(t, http.StatusCreated)
		var v versionBody
		resp.decode(t, &v)
		var hashes bytes.Buffer
		for _, f := range frames {
			sum := sha256.Sum256(f)
			hashes.Write(sum[:])
		}
		if v.ID != u.VersionID || v.ContentVersionID != v.ID || v.BlobID != u.ID || v.AuthorID != alice.id || v.ContentAuthorID != alice.id ||
			v.StoredSize != stored(frames) || v.FrameCount != 4 || v.FrameSize != testFrameSize || v.FrameHashes != b64(hashes.Bytes()) ||
			v.Suite != alice.suite || *v.Signature != alice.signature() || v.Manifest != b64([]byte(`{"manifest":true}`)) {
			t.Errorf("version = %+v", v)
		}
		if used, reserved := alice.storage(); used != stored(frames) || reserved != 0 {
			t.Errorf("after commit: used %d reserved %d", used, reserved)
		}
		if got := alice.get(file.ID); got.CurrentVersion != v.ID {
			t.Errorf("current = %s", got.CurrentVersion)
		}
		if exists(e.uploadFile(u.ID)) || !exists(e.blobFile(v.BlobID)) {
			t.Error("the file did not move")
		}

		resp = alice.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil)
		resp.wantStatus(t, http.StatusOK)
		if !bytes.Equal(resp.body, bytes.Join(frames, nil)) {
			t.Errorf("download of %d bytes differs", len(resp.body))
		}
		h := resp.header
		for name, want := range map[string]string{
			"Content-Type":           "application/octet-stream",
			"X-Content-Type-Options": "nosniff",
			"Content-Disposition":    "attachment",
			"Cache-Control":          "private, no-store",
			"ETag":                   `"` + v.BlobID + `"`,
		} {
			if got := h.Get(name); got != want {
				t.Errorf("%s = %q, want %q", name, got, want)
			}
		}
	})
}

func TestEmptyFileIsOneFrame(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, _ := driveEnv(t, mode)
		root := alice.root()
		file := alice.create(root.ID, "file", "empty")
		v := alice.upload(file.ID, alice.frames(0, 1))
		if v.FrameCount != 1 || int(v.StoredSize) != alice.overhead() {
			t.Errorf("version = %+v", v)
		}
	})
}

func TestFramingIsChecked(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, _ := driveEnv(t, mode)
		root := alice.root()
		file := alice.create(root.ID, "file", "f")
		o := int64(alice.overhead())
		stride := testFrameSize + o
		for name, f := range map[string][3]int64{
			"no frames":          {0, testFrameSize, 0},
			"too many frames":    {1<<20 + 1, testFrameSize, (1<<20 + 1) * stride},
			"small frames":       {1, 512, 100 + o},
			"large frames":       {1, 16<<20 + 1, 100 + o},
			"too long":           {1, testFrameSize, stride + 1},
			"too short":          {2, testFrameSize, stride},
			"empty last frame":   {2, testFrameSize, stride + o},
			"negative":           {1, testFrameSize, -1},
			"below the overhead": {1, testFrameSize, o - 1},
		} {
			if name == "below the overhead" && o == 0 {
				continue
			}
			req := alice.uploadRequest(file.ID, nil)
			req["frame_count"], req["frame_size"], req["stored_size"] = f[0], f[1], f[2]
			resp := alice.call(http.MethodPost, api+"/uploads", req)
			if resp.status != http.StatusBadRequest || resp.code() != "invalid_framing" {
				t.Errorf("%s: %d %s", name, resp.status, resp.body)
			}
		}
		// The largest frame the server takes is fine.
		req := alice.uploadRequest(file.ID, nil)
		req["frame_count"], req["frame_size"], req["stored_size"] = 1, 16<<20, 16<<20+o
		alice.call(http.MethodPost, api+"/uploads", req).wantStatus(t, http.StatusCreated)
	})
}

func TestFrameChecks(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		root := alice.root()
		file := alice.create(root.ID, "file", "f")
		frames := alice.frames(testFrameSize+10, 3)
		u := alice.startUpload(file.ID, frames)
		frameURL := func(n string) string { return api + "/uploads/" + u.ID + "/frames/" + n }
		cookie := []string{"Cookie", alice.cookie}

		send := func(n, body, hash string) response {
			return e.call(http.MethodPut, frameURL(n), body, append(cookie, "X-Content-SHA256", hash)...)
		}
		// Wrong digest: not stored as present.
		send("0", string(frames[0]), sumB64([]byte("other"))).wantError(t, http.StatusBadRequest, "frame_hash")
		// The right length with other bytes than promised.
		send("0", string(frames[1]), sumB64(frames[0])).wantError(t, http.StatusBadRequest, "frame_length")
		// Too short and too long, with the digest of what was sent.
		short := string(frames[0][:10])
		send("0", short, sumB64([]byte(short))).wantError(t, http.StatusBadRequest, "frame_length")
		long := string(frames[0]) + "x"
		send("0", long, sumB64([]byte(long))).wantError(t, http.StatusBadRequest, "frame_length")
		send("2", string(frames[0]), sumB64(frames[0])).wantError(t, http.StatusBadRequest, "invalid_frame")
		send("-1", string(frames[0]), sumB64(frames[0])).wantError(t, http.StatusBadRequest, "invalid_frame")
		send("x", string(frames[0]), sumB64(frames[0])).wantError(t, http.StatusBadRequest, "bad_request")
		send("0", string(frames[0]), "not base64!").wantError(t, http.StatusBadRequest, "frame_hash")
		send("0", string(frames[0]), b64([]byte("short"))).wantError(t, http.StatusBadRequest, "frame_hash")
		e.call(http.MethodPut, frameURL("0"), string(frames[0]), cookie...).wantError(t, http.StatusBadRequest, "bad_request")

		// A body without a length has to be checked as it arrives.
		req, err := http.NewRequest(http.MethodPut, e.ts.URL+frameURL("0"), io.MultiReader(strings.NewReader(short)))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Cookie", alice.cookie)
		req.Header.Set("X-Content-SHA256", sumB64([]byte(short)))
		resp, err := e.ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("chunked short frame: %d", resp.StatusCode)
		}

		var status uploadBody
		r := alice.call(http.MethodGet, api+"/uploads/"+u.ID, nil)
		r.wantStatus(t, http.StatusOK)
		r.decode(t, &status)
		if len(status.Frames) != 0 {
			t.Errorf("refused frames were recorded: %v", status.Frames)
		}

		// Missing a frame, the commit is refused, and nothing moves.
		alice.put(u.ID, 1, frames[1]).wantStatus(t, http.StatusNoContent)
		alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody()).wantError(t, http.StatusConflict, "upload_incomplete")
		if !exists(e.uploadFile(u.ID)) {
			t.Error("upload moved")
		}

		// Sending it again is a retry, and sending other bytes is a conflict.
		alice.put(u.ID, 1, frames[1]).wantStatus(t, http.StatusNoContent)
		other := bytes.Repeat([]byte{7}, len(frames[1]))
		alice.put(u.ID, 1, other).wantError(t, http.StatusConflict, "frame_conflict")

		// After all of that, the right frame goes through, and the bytes are right.
		alice.put(u.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)
		commit := alice.commitBody()
		commit["manifest"] = ""
		alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", commit).wantError(t, http.StatusBadRequest, "invalid_commit")
		commit = alice.commitBody()
		commit["manifest"] = b64(fill(1, 4<<10+1))
		alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", commit).wantError(t, http.StatusBadRequest, "invalid_commit")
		commit = alice.commitBody()
		commit["signature"] = b64(fill(1, 3))
		alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", commit).wantError(t, http.StatusBadRequest, "invalid_commit")
		r = alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody())
		r.wantStatus(t, http.StatusCreated)
		var v versionBody
		r.decode(t, &v)
		got := alice.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil)
		if !bytes.Equal(got.body, bytes.Join(frames, nil)) {
			t.Error("the stored file differs")
		}
	})
}

func TestFrameBodyLimit(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	req := alice.uploadRequest(file.ID, nil)
	req["frame_count"], req["frame_size"], req["stored_size"] = 1, 16<<20, 16<<20
	resp := alice.call(http.MethodPost, api+"/uploads", req)
	resp.wantStatus(t, http.StatusCreated)
	var u uploadBody
	resp.decode(t, &u)
	frame := bytes.Repeat([]byte{1}, 16<<20)
	// Well past the default 1 MiB, and accepted.
	alice.put(u.ID, 0, frame).wantStatus(t, http.StatusNoContent)

	// A small blob of the largest size is accepted, and one byte more is refused.
	blob := func(body []byte) response {
		return e.call(http.MethodPut, api+"/blobs/"+store.NewID()+"?kind=index&suite=none", string(body),
			"Cookie", alice.cookie, "X-Content-SHA256", sumB64(body))
	}
	blob(frame).wantStatus(t, http.StatusCreated)
	blob(append(frame, 1)).wantError(t, http.StatusRequestEntityTooLarge, "too_large")
	// An ordinary route keeps its limit.
	alice.call(http.MethodPost, api+"/nodes", `{"id":"`+strings.Repeat("x", 2<<20)+`"}`).wantError(t, http.StatusRequestEntityTooLarge, "too_large")
}

func TestConcurrentWritesOfOneFrameKeepItWhole(t *testing.T) {
	_, alice, _ := driveEnv(t, "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(testFrameSize, 5)
	u := alice.startUpload(file.ID, frames)
	other := bytes.Repeat([]byte{9}, len(frames[0]))
	var wg sync.WaitGroup
	var mu sync.Mutex
	statuses := map[int]int{}
	for i := range 16 {
		wg.Go(func() {
			frame := frames[0]
			if i%2 == 1 {
				frame = other
			}
			resp := alice.put(u.ID, 0, frame)
			mu.Lock()
			statuses[resp.status]++
			mu.Unlock()
		})
	}
	wg.Wait()
	if statuses[http.StatusNoContent] == 0 || statuses[http.StatusNoContent]+statuses[http.StatusConflict] != 16 {
		t.Errorf("statuses = %v", statuses)
	}
	resp := alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody())
	resp.wantStatus(t, http.StatusCreated)
	var v versionBody
	resp.decode(t, &v)
	got := alice.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil)
	sum := sha256.Sum256(got.body)
	if v.FrameHashes != b64(sum[:]) {
		t.Error("the stored frame does not match its recorded digest")
	}
}

func TestConcurrentCommitsCommitOnce(t *testing.T) {
	_, alice, _ := driveEnv(t, "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(10, 5)
	u := alice.startUpload(file.ID, frames)
	alice.put(u.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)
	var wg sync.WaitGroup
	var mu sync.Mutex
	statuses := map[int]int{}
	for range 8 {
		wg.Go(func() {
			resp := alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody())
			mu.Lock()
			statuses[resp.status]++
			mu.Unlock()
		})
	}
	wg.Wait()
	if statuses[http.StatusCreated] != 1 || statuses[http.StatusNotFound] != 7 {
		t.Errorf("statuses = %v", statuses)
	}
	if used, reserved := alice.storage(); used != stored(frames) || reserved != 0 {
		t.Errorf("used %d reserved %d", used, reserved)
	}
}

func TestResumeAfterAPartialUploadAndARestart(t *testing.T) {
	e, alice, _ := driveEnv(t, "e2e")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(3*testFrameSize, 2)
	u := alice.startUpload(file.ID, frames)
	alice.put(u.ID, 2, frames[2]).wantStatus(t, http.StatusNoContent)
	alice.put(u.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)

	var status uploadBody
	resp := alice.call(http.MethodGet, api+"/uploads/"+u.ID, nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &status)
	if !slices.Equal(status.Frames, []int64{0, 2}) || status.FrameCount != 3 || status.VersionID != u.VersionID {
		t.Fatalf("status = %+v", status)
	}

	// The same database and files under a new process: the upload lives on, and a
	// temp file that died with the old one does not.
	tmp := filepath.Join(e.st.Dir(), "uploads", "tmp-123")
	if err := os.WriteFile(tmp, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.ts.Close()
	e2 := startEnv(t, server.Config{}, e.st)
	if exists(tmp) {
		t.Error("the temp file survived the restart")
	}
	alice2 := &driveUser{client: e2.login("alice"), id: alice.id, mode: alice.mode, suite: alice.suite}
	resp = alice2.call(http.MethodGet, api+"/uploads/"+u.ID, nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &status)
	if !slices.Equal(status.Frames, []int64{0, 2}) {
		t.Fatalf("status after restart = %+v", status)
	}
	alice2.put(u.ID, 1, frames[1]).wantStatus(t, http.StatusNoContent)
	resp = alice2.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice2.commitBody())
	resp.wantStatus(t, http.StatusCreated)
	var v versionBody
	resp.decode(t, &v)
	got := alice2.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil)
	if !bytes.Equal(got.body, bytes.Join(frames, nil)) {
		t.Error("the resumed file differs")
	}
}

func TestStartupRepairsWhatACrashLeft(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(10, 2)
	v := alice.upload(file.ID, frames)

	// A commit that placed its file and never committed its row.
	interrupted := alice.startUpload(file.ID, frames)
	alice.put(interrupted.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)
	if err := os.MkdirAll(filepath.Dir(e.blobFile(interrupted.ID)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(e.uploadFile(interrupted.ID), e.blobFile(interrupted.ID)); err != nil {
		t.Fatal(err)
	}
	// A row with no file, and a file with no row, in both places.
	lost := alice.startUpload(file.ID, frames)
	if err := os.Remove(e.uploadFile(lost.ID)); err != nil {
		t.Fatal(err)
	}
	orphanUpload := e.uploadFile(store.NewID())
	if err := os.WriteFile(orphanUpload, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	orphanBlob := e.blobFile(strings.Repeat("a", 32))
	if err := os.MkdirAll(filepath.Dir(orphanBlob), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphanBlob, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	e.ts.Close()
	e2 := startEnv(t, server.Config{}, e.st)
	alice2 := &driveUser{client: e2.login("alice"), id: alice.id, mode: alice.mode, suite: alice.suite}

	if exists(orphanUpload) || exists(orphanBlob) {
		t.Error("orphans survived")
	}
	if !exists(e2.blobFile(v.BlobID)) {
		t.Error("the committed blob went")
	}
	if exists(e2.blobFile(interrupted.ID)) || !exists(e2.uploadFile(interrupted.ID)) {
		t.Error("the interrupted commit's file did not go back")
	}
	alice2.call(http.MethodGet, api+"/uploads/"+lost.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	if used, reserved := alice2.storage(); used != stored(frames) || reserved != stored(frames) {
		t.Errorf("used %d reserved %d", used, reserved)
	}
	alice2.call(http.MethodPost, api+"/uploads/"+interrupted.ID+"/commit", alice2.commitBody()).wantStatus(t, http.StatusCreated)
	if used, reserved := alice2.storage(); used != 2*stored(frames) || reserved != 0 {
		t.Errorf("after the commit: used %d reserved %d", used, reserved)
	}
}

func TestQuotaIsReservedAtCreation(t *testing.T) {
	e := configured(t, "none", server.Config{})
	admin := e.login("root")
	alice := newDriveUser(e, admin, "alice", "none")
	admin.call(http.MethodPatch, api+"/admin/users/"+alice.id, obj{"quota_bytes": testFrameSize}).wantStatus(t, http.StatusOK)
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(800, 1)
	first := alice.startUpload(file.ID, frames)

	// The reservation is what fills the quota, with no byte on disk yet.
	alice.call(http.MethodPost, api+"/uploads", alice.uploadRequest(file.ID, frames)).wantError(t, http.StatusRequestEntityTooLarge, "quota_exceeded")

	// Aborting releases it.
	alice.call(http.MethodDelete, api+"/uploads/"+first.ID, nil).wantStatus(t, http.StatusNoContent)
	if exists(e.uploadFile(first.ID)) {
		t.Error("the aborted file stayed")
	}
	alice.call(http.MethodDelete, api+"/uploads/"+first.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	v := alice.upload(file.ID, frames)

	// A used blob counts, and a small blob counts.
	alice.call(http.MethodPost, api+"/uploads", alice.uploadRequest(file.ID, frames)).wantError(t, http.StatusRequestEntityTooLarge, "quota_exceeded")
	big := strings.Repeat("x", 300)
	put := func(body string) response {
		return e.call(http.MethodPut, api+"/blobs/"+store.NewID()+"?kind=index&suite=none", body,
			"Cookie", alice.cookie, "X-Content-SHA256", sumB64([]byte(body)))
	}
	put(big).wantError(t, http.StatusRequestEntityTooLarge, "quota_exceeded")
	put(big[:200]).wantStatus(t, http.StatusCreated)

	// A version restored costs nothing.
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/versions/"+v.ID+"/restore", obj{"version_id": store.NewID()}).wantStatus(t, http.StatusCreated)
	if used, reserved := alice.storage(); used != 1000 || reserved != 0 {
		t.Errorf("used %d reserved %d", used, reserved)
	}
}

func TestRangeReads(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		root := alice.root()
		file := alice.create(root.ID, "file", "f")
		frames := alice.frames(2*testFrameSize+50, 1)
		all := bytes.Join(frames, nil)
		v := alice.upload(file.ID, frames)
		get := func(header ...string) response {
			return e.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil, append([]string{"Cookie", alice.cookie}, header...)...)
		}

		// A frame, as the service worker asks for one.
		stride := testFrameSize + alice.overhead()
		r := get("Range", fmt.Sprintf("bytes=%d-%d", stride, 2*stride-1))
		r.wantStatus(t, http.StatusPartialContent)
		if !bytes.Equal(r.body, frames[1]) {
			t.Error("the second frame differs")
		}
		if want := fmt.Sprintf("bytes %d-%d/%d", stride, 2*stride-1, len(all)); r.header.Get("Content-Range") != want {
			t.Errorf("Content-Range = %q, want %q", r.header.Get("Content-Range"), want)
		}
		if r.header.Get("Cache-Control") != "private, no-store" || r.header.Get("Content-Type") != "application/octet-stream" {
			t.Errorf("headers = %v", r.header)
		}

		// A suffix, an open end and an impossible range.
		r = get("Range", "bytes=-10")
		r.wantStatus(t, http.StatusPartialContent)
		if !bytes.Equal(r.body, all[len(all)-10:]) {
			t.Error("the suffix differs")
		}
		r = get("Range", fmt.Sprintf("bytes=%d-", len(all)-3))
		r.wantStatus(t, http.StatusPartialContent)
		if !bytes.Equal(r.body, all[len(all)-3:]) {
			t.Error("the open range differs")
		}
		r = get("Range", fmt.Sprintf("bytes=%d-", len(all)))
		r.wantStatus(t, http.StatusRequestedRangeNotSatisfiable)

		// If-Range holds with the tag, which never changes, and not otherwise.
		r = get("Range", "bytes=0-3", "If-Range", `"`+v.BlobID+`"`)
		r.wantStatus(t, http.StatusPartialContent)
		r = get("Range", "bytes=0-3", "If-Range", `"other"`)
		r.wantStatus(t, http.StatusOK)

		// HEAD says how long it is.
		resp := e.call(http.MethodHead, api+"/blobs/"+v.BlobID, nil, "Cookie", alice.cookie)
		resp.wantStatus(t, http.StatusOK)
		if resp.header.Get("Content-Length") != strconv.Itoa(len(all)) || resp.header.Get("Accept-Ranges") != "bytes" {
			t.Errorf("head = %v", resp.header)
		}
	})
}

func TestUploadRefusals(t *testing.T) {
	_, alice, _ := driveEnv(t, "none")
	root := alice.root()
	folder := alice.create(root.ID, "folder", "d")
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(10, 1)
	alice.call(http.MethodPost, api+"/uploads", alice.uploadRequest(folder.ID, frames)).wantError(t, http.StatusConflict, "not_a_file")
	alice.call(http.MethodPost, api+"/uploads", alice.uploadRequest(store.NewID(), frames)).wantError(t, http.StatusNotFound, "not_found")
	u := alice.startUpload(file.ID, frames)
	dup := alice.uploadRequest(file.ID, frames)
	dup["version_id"] = u.VersionID
	alice.call(http.MethodPost, api+"/uploads", dup).wantError(t, http.StatusConflict, "id_taken")

	// Trashing the node stops the upload at both ends.
	alice.put(u.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody()).wantError(t, http.StatusConflict, "node_trashed")
	alice.call(http.MethodPost, api+"/uploads", alice.uploadRequest(file.ID, frames)).wantError(t, http.StatusConflict, "node_trashed")
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/restore", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody()).wantStatus(t, http.StatusCreated)
	// The id now belongs to a version.
	alice.call(http.MethodPost, api+"/uploads", dup).wantError(t, http.StatusConflict, "id_taken")
}

func TestOptimisticCommit(t *testing.T) {
	_, alice, _ := driveEnv(t, "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(10, 1)
	commit := func(expected ...string) response {
		u := alice.startUpload(file.ID, frames)
		alice.put(u.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)
		return alice.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody(expected...))
	}
	wrong := store.NewID()
	commit(wrong).wantError(t, http.StatusPreconditionFailed, "version_conflict")
	resp := commit("")
	resp.wantStatus(t, http.StatusCreated)
	var v1 versionBody
	resp.decode(t, &v1)

	// Two saves started from the same version: the second is told.
	resp = commit(v1.ID)
	resp.wantStatus(t, http.StatusCreated)
	var v2 versionBody
	resp.decode(t, &v2)
	commit(v1.ID).wantError(t, http.StatusPreconditionFailed, "version_conflict")
	commit("").wantError(t, http.StatusPreconditionFailed, "version_conflict")
	if got := alice.get(file.ID); got.CurrentVersion != v2.ID {
		t.Errorf("current = %s", got.CurrentVersion)
	}
	// No expectation means the last commit wins.
	commit().wantStatus(t, http.StatusCreated)
}

func TestVersions(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		root := alice.root()
		file := alice.create(root.ID, "file", "f")
		first := alice.frames(10, 1)
		second := alice.frames(20, 2)
		v1 := alice.upload(file.ID, first)
		v2 := alice.upload(file.ID, second)
		size := stored(first) + stored(second)

		var got versionBody
		resp := alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/versions/"+v1.ID, nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &got)
		if got.FrameHashes == "" || got.Manifest == "" {
			t.Errorf("version = %+v", got)
		}
		alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/versions/"+store.NewID(), nil).wantError(t, http.StatusNotFound, "not_found")

		// The list leaves out what grows with the file, and pages.
		var page struct {
			Versions []json.RawMessage `json:"versions"`
			Next     string            `json:"next_cursor"`
		}
		resp = alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/versions?limit=1", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &page)
		if len(page.Versions) != 1 || page.Next == "" || bytes.Contains(page.Versions[0], []byte("frame_hashes")) ||
			!bytes.Contains(page.Versions[0], []byte(v2.ID)) {
			t.Errorf("first page = %s, next %q", page.Versions, page.Next)
		}
		resp = alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/versions?limit=1&cursor="+page.Next, nil)
		resp.wantStatus(t, http.StatusOK)
		next := page.Next
		page.Next = ""
		resp.decode(t, &page)
		if len(page.Versions) != 1 || page.Next != "" || !bytes.Contains(page.Versions[0], []byte(v1.ID)) {
			t.Errorf("second page after %s = %s, next %q", next, page.Versions, page.Next)
		}

		// Restoring points at the old blob, with no copy.
		restore := func(body obj) response {
			return alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/versions/"+v1.ID+"/restore", body)
		}
		restore(obj{"version_id": store.NewID(), "expected_version": v1.ID}).wantError(t, http.StatusPreconditionFailed, "version_conflict")
		restore(obj{"version_id": v2.ID}).wantError(t, http.StatusConflict, "id_taken")
		restore(obj{"version_id": "nope"}).wantError(t, http.StatusBadRequest, "invalid_id")
		newID := store.NewID()
		resp = restore(obj{"version_id": newID, "expected_version": v2.ID})
		resp.wantStatus(t, http.StatusCreated)
		var v3 versionBody
		resp.decode(t, &v3)
		if v3.ID != newID || v3.BlobID != v1.BlobID || v3.ContentVersionID != v1.ID || v3.ContentAuthorID != alice.id ||
			v3.FrameHashes != v1.FrameHashes || *v3.Signature != *v1.Signature || v3.Manifest != v1.Manifest {
			t.Errorf("restored = %+v", v3)
		}
		if used, _ := alice.storage(); used != size {
			t.Errorf("used %d, want %d: a restore copied", used, size)
		}
		if node := alice.get(file.ID); node.CurrentVersion != newID {
			t.Errorf("current = %s", node.CurrentVersion)
		}

		// Only a version that is not current can go, and its bytes wait.
		alice.call(http.MethodDelete, api+"/nodes/"+file.ID+"/versions/"+newID, nil).wantError(t, http.StatusConflict, "version_current")
		resp = alice.call(http.MethodDelete, api+"/nodes/"+file.ID+"/versions/"+v2.ID, nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &got)
		if got.DeletedAt == "" || got.RemoveAt == "" {
			t.Errorf("deleted = %+v", got)
		}
		e.advance(29 * day)
		if err := e.srv.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		if used, _ := alice.storage(); used != size || !exists(e.blobFile(v2.BlobID)) {
			t.Errorf("gone before the grace period: used %d", used)
		}
		// Within the grace period, it can still come back.
		undo := store.NewID()
		alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/versions/"+v2.ID+"/restore", obj{"version_id": undo}).wantStatus(t, http.StatusCreated)
		e.advance(2 * day)
		if err := e.srv.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/versions/"+v2.ID, nil).wantError(t, http.StatusNotFound, "not_found")
		if !exists(e.blobFile(v2.BlobID)) {
			t.Error("the restored copy still needs that blob")
		}

	})
}

func TestTrashAndGracePeriod(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		root := alice.root()
		folder := alice.create(root.ID, "folder", "d")
		sub := alice.create(folder.ID, "folder", "s")
		file := alice.create(sub.ID, "file", "f")
		frames := alice.frames(10, 1)
		v := alice.upload(file.ID, frames)
		pending := alice.startUpload(file.ID, frames)
		size := stored(frames)

		alice.call(http.MethodPost, api+"/nodes/"+root.ID+"/trash", nil).wantError(t, http.StatusConflict, "root_immutable")
		alice.call(http.MethodPost, api+"/nodes/"+root.ID+"/purge", nil).wantError(t, http.StatusConflict, "not_trashed")
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/purge", nil).wantError(t, http.StatusConflict, "not_trashed")
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/restore", nil).wantError(t, http.StatusConflict, "not_trashed")

		resp := alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil)
		resp.wantStatus(t, http.StatusOK)
		var n nodeBody
		resp.decode(t, &n)
		if n.TrashedAt == "" {
			t.Errorf("node = %+v", n)
		}
		// On the root of the subtree only, and twice is once.
		if got := alice.get(file.ID); got.TrashedAt != "" {
			t.Errorf("descendant = %+v", got)
		}
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)

		// Gone from the listing, in the trash, and still readable through it.
		var p pageBody
		resp = alice.call(http.MethodGet, api+"/nodes/"+root.ID+"/children", nil)
		resp.decode(t, &p)
		if len(p.Nodes) != 0 {
			t.Errorf("children = %+v", p.Nodes)
		}
		resp = alice.call(http.MethodGet, api+"/trash", nil)
		resp.decode(t, &p)
		if len(p.Nodes) != 1 || p.Nodes[0].ID != folder.ID {
			t.Errorf("trash = %+v", p.Nodes)
		}
		alice.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil).wantStatus(t, http.StatusOK)

		// Nothing happens under the trash.
		alice.call(http.MethodPost, api+"/nodes", alice.nodeRequest(folder.ID, "file", "x")).wantError(t, http.StatusConflict, "parent_trashed")
		alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/move", obj{"parent_id": root.ID, "wrapped_key": alice.wrapped(), "name_tag": tagOf("x")}).
			wantError(t, http.StatusConflict, "node_trashed")
		alice.call(http.MethodPatch, api+"/nodes/"+sub.ID, obj{"suite": alice.suite, "sealed_metadata": b64([]byte("x"))}).wantError(t, http.StatusConflict, "node_trashed")

		// Restore comes back, and purge after that needs trashing again.
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/restore", nil).wantStatus(t, http.StatusOK)
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)

		start := e.now()
		resp = alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/purge", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &n)
		wantRemove := start.Add(30 * day).Format(time.RFC3339)
		if n.PurgedAt == "" || n.RemoveAt != wantRemove {
			t.Errorf("purged = %+v, want removal at %s", n, wantRemove)
		}
		// A second purge moves nothing.
		e.advance(day)
		resp = alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/purge", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &n)
		if n.RemoveAt != wantRemove {
			t.Errorf("second purge moved the time to %s", n.RemoveAt)
		}

		// A stolen session can do no more than that: until the grace period ends
		// the bytes stay, count, and the node can be restored.
		e.advance(28*day + 23*time.Hour)
		if err := e.srv.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		if !exists(e.blobFile(v.BlobID)) {
			t.Fatal("bytes removed before the grace period")
		}
		if used, reserved := alice.storage(); used != size || reserved != 0 { // the upload was abandoned by now
			t.Errorf("used %d reserved %d", used, reserved)
		}
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/restore", nil).wantStatus(t, http.StatusOK)
		if got := alice.get(folder.ID); got.PurgedAt != "" || got.RemoveAt != "" || got.TrashedAt != "" {
			t.Errorf("restored = %+v", got)
		}
		e.advance(10 * day)
		if err := e.srv.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		alice.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil).wantStatus(t, http.StatusOK)

		// Now to the end.
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)
		alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/purge", nil).wantStatus(t, http.StatusOK)
		e.advance(30 * day)
		if err := e.srv.Sweep(ctx); err != nil {
			t.Fatal(err)
		}
		if exists(e.blobFile(v.BlobID)) || exists(e.uploadFile(pending.ID)) {
			t.Error("files survived the grace period")
		}
		if used, reserved := alice.storage(); used != 0 || reserved != 0 {
			t.Errorf("after removal: used %d reserved %d", used, reserved)
		}
		for _, id := range []string{folder.ID, sub.ID, file.ID} {
			alice.call(http.MethodGet, api+"/nodes/"+id, nil).wantError(t, http.StatusNotFound, "not_found")
		}
		alice.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil).wantError(t, http.StatusNotFound, "not_found")
	})
}

func TestEmptyTrash(t *testing.T) {
	e, alice, bob := driveEnv(t, "none")
	root := alice.root()
	a := alice.create(root.ID, "file", "a")
	b := alice.create(root.ID, "file", "b")
	keep := alice.create(root.ID, "file", "keep")
	bobRoot := bob.root()
	bobs := bob.create(bobRoot.ID, "file", "b")
	for _, n := range []struct {
		c  *driveUser
		id string
	}{{alice, a.ID}, {alice, b.ID}, {bob, bobs.ID}} {
		n.c.call(http.MethodPost, api+"/nodes/"+n.id+"/trash", nil).wantStatus(t, http.StatusOK)
	}
	resp := alice.call(http.MethodPost, api+"/trash/empty", nil)
	resp.wantStatus(t, http.StatusOK)
	var out struct {
		Marked int `json:"marked"`
	}
	resp.decode(t, &out)
	if out.Marked != 2 {
		t.Errorf("marked %d", out.Marked)
	}
	e.advance(31 * day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	alice.call(http.MethodGet, api+"/nodes/"+a.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	alice.call(http.MethodGet, api+"/nodes/"+keep.ID, nil).wantStatus(t, http.StatusOK)
	bob.call(http.MethodGet, api+"/nodes/"+bobs.ID, nil).wantStatus(t, http.StatusOK)
}

func TestTrashRetentionAndAbandonedUploads(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	admin := e.login("root")
	root := alice.root()
	old := alice.create(root.ID, "file", "old")
	frames := alice.frames(10, 1)
	v := alice.upload(old.ID, frames)
	live := alice.create(root.ID, "file", "live")
	stale := alice.startUpload(live.ID, frames)
	active := alice.startUpload(live.ID, alice.frames(2*testFrameSize, 1))
	alice.call(http.MethodPost, api+"/nodes/"+old.ID+"/trash", nil).wantStatus(t, http.StatusOK)

	// Retention marks it, and the grace period follows.
	e.advance(6 * day)
	alice.put(active.ID, 0, alice.frames(2*testFrameSize, 1)[0]).wantStatus(t, http.StatusNoContent)
	e.advance(2 * day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	alice.call(http.MethodGet, api+"/uploads/"+stale.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	if exists(e.uploadFile(stale.ID)) {
		t.Error("the abandoned file stayed")
	}
	alice.call(http.MethodGet, api+"/uploads/"+active.ID, nil).wantStatus(t, http.StatusOK)
	if got := alice.get(old.ID); got.PurgedAt != "" {
		t.Errorf("marked before its time: %+v", got)
	}

	e.advance(23 * day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if got := alice.get(old.ID); got.PurgedAt == "" || got.RemoveAt == "" {
		t.Errorf("not marked after retention: %+v", got)
	}
	e.advance(31 * day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	alice.call(http.MethodGet, api+"/nodes/"+old.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	if exists(e.blobFile(v.BlobID)) {
		t.Error("the blob stayed")
	}

	// Zero keeps the trash until someone purges.
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"trash_retention_days": 0}).wantStatus(t, http.StatusOK)
	kept := alice.create(root.ID, "file", "kept")
	alice.call(http.MethodPost, api+"/nodes/"+kept.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	e.advance(400 * day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if got := alice.get(kept.ID); got.PurgedAt != "" {
		t.Errorf("zero retention marked it: %+v", got)
	}
}

func TestShorteningTheGraceNeedsTheAuthKeyAndSparesWhatIsMarked(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	admin := e.login("root")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/purge", nil).wantStatus(t, http.StatusOK)

	admin.call(http.MethodPatch, api+"/admin/settings", obj{"purge_grace_days": 1}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"purge_grace_days": 1, "current_auth_key": b64(key("wrong"))}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"purge_grace_days": 0}).wantError(t, http.StatusBadRequest, "invalid_settings")
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"purge_grace_days": 4000}).wantError(t, http.StatusBadRequest, "invalid_settings")
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"trash_retention_days": -1}).wantError(t, http.StatusBadRequest, "invalid_settings")
	// Lengthening asks for nothing.
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"purge_grace_days": 40}).wantStatus(t, http.StatusOK)
	resp := admin.call(http.MethodPatch, api+"/admin/settings", obj{"purge_grace_days": 1, "current_auth_key": b64(key("root"))})
	resp.wantStatus(t, http.StatusOK)
	var settings struct {
		Grace int `json:"purge_grace_days"`
		Keep  int `json:"trash_retention_days"`
	}
	resp.decode(t, &settings)
	if settings.Grace != 1 || settings.Keep != 30 {
		t.Errorf("settings = %+v", settings)
	}

	// What was already marked keeps the time it was given.
	e.advance(2 * day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	alice.call(http.MethodGet, api+"/nodes/"+file.ID, nil).wantStatus(t, http.StatusOK)

	// What is marked now gets the new one.
	other := alice.create(root.ID, "file", "g")
	alice.call(http.MethodPost, api+"/nodes/"+other.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/nodes/"+other.ID+"/purge", nil).wantStatus(t, http.StatusOK)
	e.advance(day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	alice.call(http.MethodGet, api+"/nodes/"+other.ID, nil).wantError(t, http.StatusNotFound, "not_found")
}

func TestDeletingAUserRemovesTheirFiles(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	admin := e.login("root")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(10, 1)
	v := alice.upload(file.ID, frames)
	open := alice.startUpload(file.ID, frames)
	admin.call(http.MethodDelete, api+"/admin/users/"+alice.id, rootKey()).wantStatus(t, http.StatusNoContent)
	if exists(e.blobFile(v.BlobID)) || exists(e.uploadFile(open.ID)) {
		t.Error("files outlived their owner")
	}
}

func TestSmallBlobs(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		root := alice.root()
		file := alice.create(root.ID, "file", "f")
		put := func(id, query, body string, hash ...string) response {
			sum := sumB64([]byte(body))
			if len(hash) == 1 {
				sum = hash[0]
			}
			return e.call(http.MethodPut, api+"/blobs/"+id+"?suite="+url.QueryEscape(alice.suite)+query, body, "Cookie", alice.cookie, "X-Content-SHA256", sum)
		}
		thumb := store.NewID()
		put(thumb, "&kind=thumb", "x").wantError(t, http.StatusBadRequest, "invalid_blob")
		put(thumb, "&kind=index&node_id="+file.ID, "x").wantError(t, http.StatusBadRequest, "invalid_blob")
		put(thumb, "&kind=content", "x").wantError(t, http.StatusBadRequest, "invalid_blob")
		put(thumb, "&kind=thumb&node_id="+file.ID, "x", sumB64([]byte("y"))).wantError(t, http.StatusBadRequest, "frame_hash")
		put(thumb, "&kind=thumb&node_id="+file.ID, "x", "nope").wantError(t, http.StatusBadRequest, "frame_hash")
		if entries, _ := os.ReadDir(filepath.Join(e.st.Dir(), "uploads")); len(entries) != 0 {
			t.Errorf("left behind: %v", entries)
		}

		resp := put(thumb, "&kind=thumb&node_id="+file.ID, "picture")
		resp.wantStatus(t, http.StatusCreated)
		put(thumb, "&kind=thumb&node_id="+file.ID, "again").wantError(t, http.StatusConflict, "id_taken")
		if n := alice.get(file.ID); n.ThumbBlobID != thumb {
			t.Errorf("thumb = %q", n.ThumbBlobID)
		}
		got := alice.call(http.MethodGet, api+"/blobs/"+thumb, nil)
		got.wantStatus(t, http.StatusOK)
		if string(got.body) != "picture" || got.header.Get("Content-Disposition") != "attachment" {
			t.Errorf("thumb = %q, %v", got.body, got.header)
		}
		if used, _ := alice.storage(); used != 7 {
			t.Errorf("used %d", used)
		}

		// A new one replaces the old one, whose file goes.
		next := store.NewID()
		put(next, "&kind=thumb&node_id="+file.ID, "pic").wantStatus(t, http.StatusCreated)
		if n := alice.get(file.ID); n.ThumbBlobID != next {
			t.Errorf("thumb = %q", n.ThumbBlobID)
		}
		if exists(e.blobFile(thumb)) {
			t.Error("old thumbnail stayed")
		}
		alice.call(http.MethodGet, api+"/blobs/"+thumb, nil).wantError(t, http.StatusNotFound, "not_found")

		var ids []string
		for range 3 {
			id := store.NewID()
			ids = append(ids, id)
			put(id, "&kind=index", "segment").wantStatus(t, http.StatusCreated)
		}
		slices.Sort(ids)
		var list struct {
			Blobs []struct {
				ID   string `json:"id"`
				Kind string `json:"kind"`
				Size int64  `json:"size"`
			} `json:"blobs"`
			Next string `json:"next_cursor"`
		}
		resp = alice.call(http.MethodGet, api+"/me/index?limit=2", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &list)
		if len(list.Blobs) != 2 || list.Blobs[0].ID != ids[0] || list.Blobs[0].Kind != "index" || list.Blobs[0].Size != 7 || list.Next != ids[1] {
			t.Errorf("index = %+v", list)
		}
		if used, _ := alice.storage(); used != 3+21 {
			t.Errorf("used %d", used)
		}
		alice.call(http.MethodDelete, api+"/blobs/"+ids[0], nil).wantStatus(t, http.StatusNoContent)
		if exists(e.blobFile(ids[0])) {
			t.Error("index file stayed")
		}
		alice.call(http.MethodDelete, api+"/blobs/"+ids[0], nil).wantError(t, http.StatusNotFound, "not_found")
		alice.call(http.MethodDelete, api+"/blobs/"+next, nil).wantStatus(t, http.StatusNoContent)
		if n := alice.get(file.ID); n.ThumbBlobID != "" {
			t.Errorf("thumb = %q", n.ThumbBlobID)
		}

		// Content has its own way out.
		v := alice.upload(file.ID, alice.frames(10, 1))
		alice.call(http.MethodDelete, api+"/blobs/"+v.BlobID, nil).wantError(t, http.StatusConflict, "blob_in_use")
	})
}

func TestChangeJournal(t *testing.T) {
	e, alice, bob := driveEnv(t, "none")
	root := alice.root()
	bobRoot := bob.root()
	file := alice.create(root.ID, "file", "f")
	folder := alice.create(root.ID, "folder", "d")
	bob.create(bobRoot.ID, "file", "secret")
	frames := alice.frames(10, 1)
	v := alice.upload(file.ID, frames)
	alice.call(http.MethodPatch, api+"/nodes/"+file.ID, obj{"suite": noneSuite, "sealed_metadata": b64([]byte("m"))}).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/move", obj{"parent_id": folder.ID, "wrapped_key": "", "name_tag": tagOf("f")}).wantStatus(t, http.StatusOK)
	r := alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/versions/"+v.ID+"/restore", obj{"version_id": store.NewID()})
	r.wantStatus(t, http.StatusCreated)
	alice.call(http.MethodDelete, api+"/nodes/"+file.ID+"/versions/"+v.ID, nil).wantStatus(t, http.StatusOK)
	put := func() response {
		return e.call(http.MethodPut, api+"/blobs/"+store.NewID()+"?kind=thumb&suite=none&node_id="+file.ID, "x", "Cookie", alice.cookie, "X-Content-SHA256", sumB64([]byte("x")))
	}
	put().wantStatus(t, http.StatusCreated)
	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/restore", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/purge", nil).wantStatus(t, http.StatusOK)
	e.advance(31 * day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}

	type change struct {
		Seq    int64  `json:"seq"`
		NodeID string `json:"node_id"`
		Op     string `json:"op"`
	}
	read := func(c *driveUser, cursor string, limit int) ([]change, string) {
		path := fmt.Sprintf("%s/changes?limit=%d", api, limit)
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		resp := c.call(http.MethodGet, path, nil)
		resp.wantStatus(t, http.StatusOK)
		var out struct {
			Changes []change `json:"changes"`
			Next    string   `json:"next_cursor"`
		}
		resp.decode(t, &out)
		return out.Changes, out.Next
	}
	var all []change
	cursor := ""
	for range 50 {
		page, next := read(alice, cursor, 3)
		if len(page) == 0 {
			if next != cursor {
				t.Errorf("empty page moved the cursor from %q to %q", cursor, next)
			}
			break
		}
		all = append(all, page...)
		cursor = next
	}
	var ops []string
	for i, c := range all {
		ops = append(ops, c.Op)
		if i > 0 && c.Seq <= all[i-1].Seq {
			t.Errorf("sequence went back at %d", i)
		}
		if c.NodeID == bobRoot.ID {
			t.Error("alice saw bob's journal")
		}
	}
	want := []string{"created", "created", "created", "version", "updated", "moved", "version", "version_deleted", "thumbnail",
		"trashed", "restored", "trashed", "purged", "removed"}
	if !slices.Equal(ops, want) {
		t.Errorf("ops = %v\nwant  %v", ops, want)
	}

	// A stored cursor picks up exactly where it stopped, after anything else.
	after := alice.create(root.ID, "file", "later")
	page, next := read(alice, cursor, 10)
	if len(page) != 1 || page[0].NodeID != after.ID {
		t.Errorf("after the cursor = %+v", page)
	}
	if empty, same := read(alice, next, 10); len(empty) != 0 || same != next {
		t.Errorf("past the end = %+v, %q", empty, same)
	}

	// Bob sees only his two entries.
	bobs, _ := read(bob, "", 100)
	if len(bobs) != 2 {
		t.Errorf("bob's journal = %+v", bobs)
	}
}

func TestAdminHealth(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	admin := e.login("root")
	alice.call(http.MethodGet, api+"/admin/health", nil).wantError(t, http.StatusForbidden, "forbidden")
	e.call(http.MethodGet, api+"/admin/health", nil).wantError(t, http.StatusUnauthorized, "unauthorized")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(10, 1)
	alice.upload(file.ID, frames)
	alice.startUpload(file.ID, frames)

	resp := admin.call(http.MethodGet, api+"/admin/health", nil)
	resp.wantStatus(t, http.StatusOK)
	var h struct {
		Mode     string `json:"mode"`
		Blobs    int64  `json:"blobs"`
		Stored   int64  `json:"stored_bytes"`
		Uploads  int64  `json:"uploads"`
		Reserved int64  `json:"reserved_bytes"`
		Pending  int64  `json:"pending_removals"`
		Free     *int64 `json:"free_bytes"`
		Last     string `json:"last_backup_at"`
	}
	resp.decode(t, &h)
	if h.Mode != "none" || h.Blobs != 1 || h.Stored != 10 || h.Uploads != 1 || h.Reserved != 10 || h.Pending != 0 || h.Free == nil || h.Last != "" {
		t.Errorf("health = %+v", h)
	}
}

func TestBearerTokensWorkOnTheDrive(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	resp := alice.call(http.MethodPost, api+"/me/tokens", obj{"name": "phone", "current_auth_key": b64(key("alice"))})
	resp.wantStatus(t, http.StatusCreated)
	var token struct {
		Secret string `json:"secret"`
	}
	resp.decode(t, &token)
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frame := alice.frames(10, 1)[0]
	body := alice.uploadRequest(file.ID, [][]byte{frame})
	bearer := []string{"Authorization", "Bearer " + token.Secret}
	resp = e.call(http.MethodPost, api+"/uploads", body, bearer...)
	resp.wantStatus(t, http.StatusCreated)
	var u uploadBody
	resp.decode(t, &u)
	e.call(http.MethodPut, api+"/uploads/"+u.ID+"/frames/0", string(frame), append(bearer, "X-Content-SHA256", sumB64(frame))...).wantStatus(t, http.StatusNoContent)
	e.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", alice.commitBody(), bearer...).wantStatus(t, http.StatusCreated)
}

func TestFrameRoutesRefuseCrossSiteBrowsers(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frame := alice.frames(10, 1)[0]
	u := alice.startUpload(file.ID, [][]byte{frame})
	e.call(http.MethodPut, api+"/uploads/"+u.ID+"/frames/0", string(frame),
		"Cookie", alice.cookie, "X-Content-SHA256", sumB64(frame), "Sec-Fetch-Site", "cross-site").wantError(t, http.StatusForbidden, "forbidden")
}

func TestTheBytesOfADeletedVersionGoAfterTheGrace(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	old := alice.upload(file.ID, alice.frames(10, 1))
	current := alice.upload(file.ID, alice.frames(20, 2))
	alice.call(http.MethodDelete, api+"/nodes/"+file.ID+"/versions/"+old.ID, nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodDelete, api+"/nodes/"+file.ID+"/versions/"+old.ID, nil).wantStatus(t, http.StatusOK)
	if used, _ := alice.storage(); used != 30 {
		t.Errorf("used %d: quota counts it until removal", used)
	}
	e.advance(30 * day)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if exists(e.blobFile(old.BlobID)) || !exists(e.blobFile(current.BlobID)) {
		t.Error("the wrong blob went")
	}
	if used, _ := alice.storage(); used != 20 {
		t.Errorf("used %d", used)
	}
	alice.call(http.MethodGet, api+"/blobs/"+old.BlobID, nil).wantError(t, http.StatusNotFound, "not_found")
}

func TestSweepBeforeSetupDoesNothing(t *testing.T) {
	e := newEnv(t, server.Config{})
	if err := e.srv.Sweep(ctx); err != nil {
		t.Errorf("sweep: %v", err)
	}
}

func TestAFrameThatStallsRunsOutOfTime(t *testing.T) {
	e := configured(t, "none", server.Config{FrameTimeout: 200 * time.Millisecond})
	admin := e.login("root")
	alice := newDriveUser(e, admin, "alice", "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frame := alice.frames(10, 1)[0]
	u := alice.startUpload(file.ID, [][]byte{frame})

	body, writer := io.Pipe()
	defer func() { _ = writer.Close() }()
	req, err := http.NewRequest(http.MethodPut, e.ts.URL+api+"/uploads/"+u.ID+"/frames/0", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Cookie", alice.cookie)
	req.Header.Set("X-Content-SHA256", sumB64(frame))
	go func() { _, _ = writer.Write(frame[:3]) }()
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d", resp.StatusCode)
	}
	var status uploadBody
	r := alice.call(http.MethodGet, api+"/uploads/"+u.ID, nil)
	r.wantStatus(t, http.StatusOK)
	r.decode(t, &status)
	if len(status.Frames) != 0 {
		t.Errorf("frames = %v", status.Frames)
	}
}

func TestOneFileThatWillNotGoDoesNotStallTheRest(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	root := alice.root()
	file := alice.create(root.ID, "file", "f")
	frames := alice.frames(10, 1)
	abort := func(id string) {
		alice.call(http.MethodDelete, api+"/uploads/"+id, nil).wantStatus(t, http.StatusNoContent)
	}

	// A directory with something in it cannot be unlinked, and is not a missing
	// file either. Several, so that one is sure to come up ahead of the others.
	var stuck, fine []string
	for range 8 {
		u := alice.startUpload(file.ID, frames)
		if err := os.Remove(e.uploadFile(u.ID)); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(e.uploadFile(u.ID), "inner"), 0o700); err != nil {
			t.Fatal(err)
		}
		abort(u.ID)
		stuck = append(stuck, u.ID)
	}
	for range 8 {
		u := alice.startUpload(file.ID, frames)
		abort(u.ID)
		fine = append(fine, u.ID)
	}
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	for _, id := range fine {
		if exists(e.uploadFile(id)) {
			t.Errorf("file of %s stayed behind one that would not go", id)
		}
	}
	// The ones that failed are still queued, and go once they can.
	for _, id := range stuck {
		if err := os.RemoveAll(e.uploadFile(id)); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	pending, err := e.st.PendingFileRemovals(ctx, 100)
	if err != nil || len(pending) != 0 {
		t.Errorf("pending %v, %v", pending, err)
	}
}
