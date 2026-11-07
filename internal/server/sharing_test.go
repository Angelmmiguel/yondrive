package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// sealedGrant is what a client seals to a grantee, or nothing without keys.
func (d *driveUser) sealedGrant() string {
	if d.mode == "e2e" {
		return b64(fill(3, 105))
	}
	return ""
}

func (d *driveUser) sealedKey() string {
	if d.mode == "e2e" {
		return b64(fill(4, 73))
	}
	return ""
}

type grantBody struct {
	ID              string `json:"id"`
	NodeID          string `json:"node_id"`
	GranteeID       string `json:"grantee_id"`
	GranteeUsername string `json:"grantee_username"`
	GranterID       string `json:"granter_id"`
	GranterUsername string `json:"granter_username"`
	Role            string `json:"role"`
	KeyGeneration   int64  `json:"key_generation"`
	SealedKey       string `json:"sealed_key"`
	Signature       string `json:"signature"`
}

type grantedNodeBody struct {
	Grant grantBody `json:"grant"`
	Node  struct {
		nodeBody
		Role          string `json:"role"`
		KeyGeneration int64  `json:"key_generation"`
	} `json:"node"`
}

type grantPageBody struct {
	Items      []grantedNodeBody `json:"items"`
	NextCursor string            `json:"next_cursor"`
}

func (d *driveUser) grantRequest(node, grantee, role string) obj {
	return obj{"node_id": node, "grantee_id": grantee, "role": role, "key_generation": 1,
		"sealed_key": d.sealedGrant(), "signature": d.signature()}
}

func (d *driveUser) share(node string, grantee *driveUser, role string) grantBody {
	d.e.t.Helper()
	resp := d.call(http.MethodPost, api+"/grants", d.grantRequest(node, grantee.id, role))
	resp.wantStatus(d.e.t, http.StatusCreated)
	var g grantBody
	resp.decode(d.e.t, &g)
	return g
}

// sharedFolder returns alice's root and a folder in it shared with bob.
func sharedFolder(t *testing.T, alice, bob *driveUser, role string) (root, folder nodeBody, grant grantBody) {
	t.Helper()
	root = alice.root()
	folder = alice.create(root.ID, "folder", "shared")
	grant = alice.share(folder.ID, bob, role)
	return root, folder, grant
}

func TestGrantLifecycle(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		_, folder, g := sharedFolder(t, alice, bob, "viewer")
		if g.GranterID != alice.id || g.GranteeID != bob.id || g.GranterUsername != "alice" || g.GranteeUsername != "bob" || g.KeyGeneration != 1 {
			t.Errorf("grant %+v", g)
		}
		if !e.audited("grant_created") {
			t.Error("no audit row")
		}

		var mine grantPageBody
		resp := bob.call(http.MethodGet, api+"/shared-with-me", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &mine)
		if len(mine.Items) != 1 || mine.Items[0].Grant.GranterUsername != "alice" || mine.Items[0].Grant.SealedKey != alice.sealedGrant() ||
			mine.Items[0].Node.ID != folder.ID || mine.Items[0].Node.Role != "viewer" {
			t.Errorf("shared with me %s", resp.body)
		}

		var made grantPageBody
		resp = alice.call(http.MethodGet, api+"/grants", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &made)
		if len(made.Items) != 1 || made.Items[0].Grant.ID != g.ID || made.Items[0].Node.Role != "owner" {
			t.Errorf("grants made %s", resp.body)
		}

		resp = alice.call(http.MethodPatch, api+"/grants/"+g.ID, obj{"role": "editor", "signature": alice.signature()})
		resp.wantStatus(t, http.StatusOK)
		var changed grantBody
		resp.decode(t, &changed)
		if changed.Role != "editor" {
			t.Errorf("role %s", changed.Role)
		}
		if !e.audited("grant_role_changed") {
			t.Error("no audit row for the role")
		}

		alice.call(http.MethodDelete, api+"/grants/"+g.ID, nil).wantStatus(t, http.StatusNoContent)
		if !e.audited("grant_revoked") {
			t.Error("no audit row for the revocation")
		}
		bob.call(http.MethodGet, api+"/nodes/"+folder.ID, nil).wantError(t, http.StatusNotFound, "not_found")
		alice.call(http.MethodDelete, api+"/grants/"+g.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	})
}

func TestGrantRefusals(t *testing.T) {
	e, alice, bob := driveEnv(t, "e2e")
	root := alice.root()
	folder := alice.create(root.ID, "folder", "f")
	post := func(body obj) response { return alice.call(http.MethodPost, api+"/grants", body) }

	with := func(k string, v any) obj {
		b := alice.grantRequest(folder.ID, bob.id, "viewer")
		b[k] = v
		return b
	}
	post(with("sealed_key", b64(fill(1, 104)))).wantError(t, http.StatusBadRequest, "invalid_grant")
	post(with("sealed_key", "")).wantError(t, http.StatusBadRequest, "invalid_grant")
	post(with("signature", b64(fill(1, 63)))).wantError(t, http.StatusBadRequest, "invalid_grant")
	post(with("signature", "")).wantError(t, http.StatusBadRequest, "invalid_grant")
	post(with("role", "owner")).wantError(t, http.StatusBadRequest, "invalid_grant")
	post(with("grantee_id", alice.id)).wantError(t, http.StatusBadRequest, "invalid_grant")
	post(with("grantee_id", "nope")).wantError(t, http.StatusBadRequest, "invalid_id")
	post(with("grantee_id", store.NewID())).wantError(t, http.StatusNotFound, "not_found")
	post(with("key_generation", 2)).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")
	post(with("node_id", root.ID)).wantError(t, http.StatusConflict, "root_immutable")

	post(with("role", "viewer")).wantStatus(t, http.StatusCreated)
	post(with("role", "editor")).wantError(t, http.StatusConflict, "grant_exists")

	admin := e.login("root")
	carol := newDriveUser(e, admin, "carol", "e2e")
	admin.call(http.MethodPatch, api+"/admin/users/"+carol.id, obj{"disabled": true}).wantStatus(t, http.StatusOK)
	post(with("grantee_id", carol.id)).wantError(t, http.StatusNotFound, "not_found")

	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	dave := newDriveUser(e, admin, "dave", "e2e")
	post(with("grantee_id", dave.id)).wantError(t, http.StatusConflict, "node_trashed")
}

func TestGrantBlobsFollowTheMode(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	folder := alice.create(alice.root().ID, "folder", "f")
	body := alice.grantRequest(folder.ID, bob.id, "viewer")
	body["sealed_key"] = b64(fill(1, 105))
	alice.call(http.MethodPost, api+"/grants", body).wantError(t, http.StatusBadRequest, "invalid_grant")
	body = alice.grantRequest(folder.ID, bob.id, "viewer")
	body["signature"] = b64(fill(1, 64))
	alice.call(http.MethodPost, api+"/grants", body).wantError(t, http.StatusBadRequest, "invalid_grant")
}

// A stranger gets what they would get if nothing were there.
func TestStrangersCannotTellAGrantExists(t *testing.T) {
	e, alice, bob := driveEnv(t, "e2e")
	carol := newDriveUser(e, e.login("root"), "carol", "e2e")
	_, folder, g := sharedFolder(t, alice, bob, "editor")
	file := alice.create(folder.ID, "file", "file")
	v := alice.upload(file.ID, alice.frames(2000, 1))

	for _, r := range []struct{ method, path string }{
		{http.MethodGet, "/nodes/" + folder.ID},
		{http.MethodGet, "/nodes/" + folder.ID + "/children"},
		{http.MethodGet, "/nodes/" + folder.ID + "/grants"},
		{http.MethodGet, "/nodes/" + file.ID + "/versions"},
		{http.MethodGet, "/nodes/" + file.ID + "/versions/" + v.ID},
		{http.MethodGet, "/blobs/" + v.BlobID},
		{http.MethodPost, "/nodes/" + folder.ID + "/trash"},
		{http.MethodDelete, "/grants/" + g.ID},
	} {
		carol.call(r.method, api+r.path, nil).wantError(t, http.StatusNotFound, "not_found")
	}
	carol.call(http.MethodPatch, api+"/grants/"+g.ID, obj{"role": "viewer", "signature": carol.signature()}).wantError(t, http.StatusNotFound, "not_found")
	carol.call(http.MethodPost, api+"/grants", carol.grantRequest(folder.ID, carol.id, "editor")).wantError(t, http.StatusNotFound, "not_found")
	carol.call(http.MethodPost, api+"/nodes/"+folder.ID+"/rotate", rotateBody(carol, 1)).wantError(t, http.StatusNotFound, "not_found")

	var mine grantPageBody
	resp := carol.call(http.MethodGet, api+"/shared-with-me", nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &mine)
	if len(mine.Items) != 0 {
		t.Errorf("carol holds %s", resp.body)
	}
	resp = carol.call(http.MethodGet, api+"/grants", nil)
	resp.decode(t, &mine)
	if len(mine.Items) != 0 {
		t.Errorf("carol made %s", resp.body)
	}

	// Sealed keys and others' grants stay with the owner.
	var access struct {
		Access []map[string]any `json:"access"`
	}
	dave := newDriveUser(e, e.login("root"), "dave", "e2e")
	alice.share(folder.ID, dave, "viewer")
	sub := alice.create(folder.ID, "folder", "sub")
	erin := newDriveUser(e, e.login("root"), "erin", "e2e")
	alice.share(sub.ID, erin, "viewer")
	// Anyone but the owner sees their own grants and the editors, whose keys
	// check the versions they read, and not who else may only read.
	names := func(as *driveUser, node string) []string {
		t.Helper()
		resp := as.call(http.MethodGet, api+"/nodes/"+node+"/grants", nil)
		resp.wantStatus(t, http.StatusOK)
		access.Access = nil
		resp.decode(t, &access)
		var out []string
		for _, a := range access.Access {
			if as != alice {
				if _, ok := a["sealed_key"]; ok {
					t.Errorf("a grantee sees a sealed key: %s", resp.body)
				}
				_, hasID := a["grant_id"]
				if own := a["user_id"] == as.id; hasID != own {
					t.Errorf("grant id of %v: %s", a["username"], resp.body)
				}
			}
			out = append(out, a["username"].(string))
		}
		slices.Sort(out)
		return out
	}
	for _, c := range []struct {
		as   *driveUser
		node string
		want []string
	}{
		{bob, folder.ID, []string{"bob"}},
		{dave, folder.ID, []string{"bob", "dave"}},
		{erin, sub.ID, []string{"bob", "erin"}},
		{alice, sub.ID, []string{"bob", "dave", "erin"}},
	} {
		if got := names(c.as, c.node); !slices.Equal(got, c.want) {
			t.Errorf("%s sees %v, want %v", c.as.id, got, c.want)
		}
	}
	resp = alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/grants", nil)
	resp.decode(t, &access)
	if access.Access[0]["inherited"] != true || access.Access[0]["sealed_key"] == nil {
		t.Errorf("owner's view %s", resp.body)
	}
}

func TestViewerReadsOnly(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, bob := driveEnv(t, mode)
		_, folder, _ := sharedFolder(t, alice, bob, "viewer")
		file := alice.create(folder.ID, "file", "file")
		v := alice.upload(file.ID, alice.frames(2000, 1))
		v2 := alice.upload(file.ID, alice.frames(1500, 2))

		for _, path := range []string{"/nodes/" + folder.ID, "/nodes/" + folder.ID + "/children", "/nodes/" + file.ID,
			"/nodes/" + file.ID + "/versions", "/nodes/" + file.ID + "/versions/" + v.ID, "/blobs/" + v.BlobID, "/blobs/" + v2.BlobID} {
			bob.call(http.MethodGet, api+path, nil).wantStatus(t, http.StatusOK)
		}
		var n struct {
			Role string `json:"role"`
		}
		bob.call(http.MethodGet, api+"/nodes/"+file.ID, nil).decode(t, &n)
		if n.Role != "viewer" {
			t.Errorf("role %q", n.Role)
		}

		forbidden := func(r response) {
			t.Helper()
			r.wantError(t, http.StatusForbidden, "forbidden")
		}
		forbidden(bob.call(http.MethodPost, api+"/nodes", bob.nodeRequest(folder.ID, "file", "new")))
		forbidden(bob.call(http.MethodPatch, api+"/nodes/"+file.ID, obj{"suite": bob.suite, "sealed_metadata": b64([]byte("m"))}))
		forbidden(bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/trash", nil))
		forbidden(bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/move", obj{"parent_id": folder.ID, "wrapped_key": bob.wrapped(), "name_tag": tagOf("x")}))
		forbidden(bob.call(http.MethodPost, api+"/uploads", bob.uploadRequest(file.ID, bob.frames(10, 1))))
		forbidden(bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/versions/"+v.ID+"/restore", obj{"version_id": store.NewID()}))
		forbidden(bob.call(http.MethodDelete, api+"/nodes/"+file.ID+"/versions/"+v.ID, nil))
		forbidden(bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/purge", nil))
		forbidden(bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/restore", nil))
		forbidden(bob.call(http.MethodPost, api+"/grants", bob.grantRequest(folder.ID, bob.id, "editor")))
		forbidden(bob.e.call(http.MethodPut, api+"/blobs/"+store.NewID()+"?kind=thumb&suite="+bob.suite+"&node_id="+file.ID, "t",
			"Cookie", bob.cookie, "X-Content-SHA256", sumB64([]byte("t"))))
	})
}

func TestEditorLimits(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		root, folder, g := sharedFolder(t, alice, bob, "editor")
		other := alice.create(root.ID, "folder", "other")
		sub := bob.create(folder.ID, "folder", "sub")
		file := bob.create(folder.ID, "file", "file")
		if file.OwnerID != alice.id {
			t.Errorf("a node made by an editor belongs to %s", file.OwnerID)
		}

		// Renames, moves within the subtree, versions and trash.
		bob.call(http.MethodPatch, api+"/nodes/"+file.ID, obj{"suite": bob.suite, "name_tag": tagOf("renamed")}).wantStatus(t, http.StatusOK)
		move := func(id, parent, name string) response {
			return bob.call(http.MethodPost, api+"/nodes/"+id+"/move", obj{"parent_id": parent, "wrapped_key": bob.wrapped(), "name_tag": tagOf(name)})
		}
		move(file.ID, sub.ID, "moved").wantStatus(t, http.StatusOK)

		frames := bob.frames(2000, 1)
		v := bob.upload(file.ID, frames)
		if v.AuthorID != bob.id {
			t.Errorf("author %s", v.AuthorID)
		}
		if used, _ := alice.storage(); used != stored(frames) {
			t.Errorf("owner is charged %d, want %d", used, stored(frames))
		}
		if used, _ := bob.storage(); used != 0 {
			t.Errorf("editor is charged %d", used)
		}
		v2 := bob.upload(file.ID, bob.frames(1000, 2))
		bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/versions/"+v.ID+"/restore", obj{"version_id": store.NewID()}).wantStatus(t, http.StatusCreated)
		bob.call(http.MethodDelete, api+"/nodes/"+file.ID+"/versions/"+v2.ID, nil).wantError(t, http.StatusForbidden, "forbidden")

		// Out of the subtree, and across owners.
		move(file.ID, other.ID, "x").wantError(t, http.StatusNotFound, "not_found")
		move(file.ID, bob.root().ID, "x").wantError(t, http.StatusForbidden, "move_refused")
		mine := bob.create(bob.root().ID, "file", "mine")
		move(mine.ID, sub.ID, "x").wantError(t, http.StatusForbidden, "move_refused")

		// A second grant does not join two subtrees.
		alice.share(other.ID, bob, "editor")
		move(file.ID, other.ID, "x").wantError(t, http.StatusForbidden, "move_refused")

		// The node of the grant lives in a folder the editor cannot write to.
		bob.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantError(t, http.StatusForbidden, "forbidden")
		bob.call(http.MethodPatch, api+"/nodes/"+folder.ID, obj{"suite": bob.suite, "name_tag": tagOf("r")}).wantError(t, http.StatusForbidden, "forbidden")
		move(folder.ID, other.ID, "x").wantError(t, http.StatusForbidden, "move_refused")
		bob.call(http.MethodPatch, api+"/nodes/"+folder.ID, obj{"suite": bob.suite, "sealed_metadata": b64([]byte("m"))}).wantStatus(t, http.StatusOK)

		// Only an owner shares.
		carol := newDriveUser(e, e.login("root"), "carol", mode)
		bob.call(http.MethodPost, api+"/grants", bob.grantRequest(folder.ID, carol.id, "viewer")).wantError(t, http.StatusForbidden, "forbidden")
		bob.call(http.MethodPatch, api+"/grants/"+g.ID, obj{"role": "editor", "signature": bob.signature()}).wantError(t, http.StatusForbidden, "forbidden")

		bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/trash", nil).wantStatus(t, http.StatusOK)
		bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/restore", nil).wantError(t, http.StatusNotFound, "not_found")
		bob.call(http.MethodPost, api+"/nodes/"+file.ID+"/purge", nil).wantError(t, http.StatusNotFound, "not_found")
		alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/restore", nil).wantStatus(t, http.StatusOK)
	})
}

func TestEditorQuotaIsTheOwners(t *testing.T) {
	e, alice, bob := driveEnv(t, "none")
	admin := e.login("root")
	_, folder, _ := sharedFolder(t, alice, bob, "editor")
	file := bob.create(folder.ID, "file", "f")
	// Room for 100 bytes of content over the metadata the nodes hold.
	admin.call(http.MethodPatch, api+"/admin/users/"+alice.id, obj{"quota_bytes": 100 + alice.metadataBytes()}).wantStatus(t, http.StatusOK)
	bob.call(http.MethodPost, api+"/uploads", bob.uploadRequest(file.ID, bob.frames(101, 1))).wantError(t, http.StatusRequestEntityTooLarge, "quota_exceeded")
	bob.startUpload(file.ID, bob.frames(100, 1))
	if _, reserved := alice.storage(); reserved != 100 {
		t.Errorf("owner reserved %d", reserved)
	}
}

func TestRevokedUserIsGoneAtOnce(t *testing.T) {
	_, alice, bob := driveEnv(t, "e2e")
	_, folder, g := sharedFolder(t, alice, bob, "editor")
	file := alice.create(folder.ID, "file", "file")
	v := alice.upload(file.ID, alice.frames(2000, 1))
	frames := bob.frames(2000, 3)
	u := bob.startUpload(file.ID, frames)
	bob.put(u.ID, 0, frames[0]).wantStatus(t, http.StatusNoContent)

	alice.call(http.MethodDelete, api+"/grants/"+g.ID, nil).wantStatus(t, http.StatusNoContent)

	for _, path := range []string{"/nodes/" + folder.ID, "/nodes/" + folder.ID + "/children", "/nodes/" + file.ID, "/nodes/" + file.ID + "/grants",
		"/nodes/" + file.ID + "/versions", "/nodes/" + file.ID + "/versions/" + v.ID, "/blobs/" + v.BlobID, "/uploads/" + u.ID} {
		bob.call(http.MethodGet, api+path, nil).wantError(t, http.StatusNotFound, "not_found")
	}
	bob.put(u.ID, 1, frames[1]).wantError(t, http.StatusNotFound, "not_found")
	bob.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", bob.commitBody()).wantError(t, http.StatusNotFound, "not_found")
	bob.call(http.MethodPost, api+"/nodes", bob.nodeRequest(folder.ID, "file", "x")).wantError(t, http.StatusNotFound, "not_found")
	if _, reserved := alice.storage(); reserved != 0 {
		t.Errorf("the revoked upload still reserves %d", reserved)
	}

	var mine grantPageBody
	bob.call(http.MethodGet, api+"/shared-with-me", nil).decode(t, &mine)
	if len(mine.Items) != 0 {
		t.Errorf("still listed: %+v", mine.Items)
	}
}

func TestGranteeRemovesTheirOwnGrant(t *testing.T) {
	e, alice, bob := driveEnv(t, "none")
	_, folder, g := sharedFolder(t, alice, bob, "viewer")
	bob.call(http.MethodPatch, api+"/grants/"+g.ID, obj{"role": "editor", "signature": ""}).wantError(t, http.StatusForbidden, "forbidden")
	bob.call(http.MethodDelete, api+"/grants/"+g.ID, nil).wantStatus(t, http.StatusNoContent)
	if !e.audited("grant_left") {
		t.Error("no audit row")
	}
	bob.call(http.MethodGet, api+"/nodes/"+folder.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	alice.call(http.MethodGet, api+"/nodes/"+folder.ID, nil).wantStatus(t, http.StatusOK)
}

func TestRolesFollowAMovedSubtree(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	root := alice.root()
	shared := alice.create(root.ID, "folder", "shared")
	private := alice.create(root.ID, "folder", "private")
	sub := alice.create(shared.ID, "folder", "sub")
	deep := alice.create(sub.ID, "file", "deep")
	alice.share(shared.ID, bob, "viewer")

	bob.call(http.MethodGet, api+"/nodes/"+deep.ID, nil).wantStatus(t, http.StatusOK)
	move := func(parent string) {
		t.Helper()
		alice.call(http.MethodPost, api+"/nodes/"+sub.ID+"/move", obj{"parent_id": parent, "wrapped_key": "", "name_tag": tagOf("sub")}).wantStatus(t, http.StatusOK)
	}
	move(private.ID)
	bob.call(http.MethodGet, api+"/nodes/"+deep.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	bob.call(http.MethodGet, api+"/nodes/"+sub.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	move(shared.ID)
	bob.call(http.MethodGet, api+"/nodes/"+deep.ID, nil).wantStatus(t, http.StatusOK)

	// An owner moving a folder with its own grant keeps that grant with it.
	alice.share(sub.ID, bob, "editor")
	move(private.ID)
	var n struct {
		Role string `json:"role"`
	}
	resp := bob.call(http.MethodGet, api+"/nodes/"+deep.ID, nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &n)
	if n.Role != "editor" {
		t.Errorf("role %q", n.Role)
	}
}

func TestStrongestRoleWins(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	_, folder, _ := sharedFolder(t, alice, bob, "viewer")
	strong := alice.create(folder.ID, "folder", "strong")
	weak := alice.create(folder.ID, "file", "weak")
	inner := alice.create(strong.ID, "file", "inner")
	alice.share(strong.ID, bob, "editor")

	var page struct {
		Nodes []struct {
			ID   string `json:"id"`
			Role string `json:"role"`
		} `json:"nodes"`
	}
	resp := bob.call(http.MethodGet, api+"/nodes/"+folder.ID+"/children", nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &page)
	for _, n := range page.Nodes {
		want := map[string]string{strong.ID: "editor", weak.ID: "viewer"}[n.ID]
		if n.Role != want {
			t.Errorf("%s: role %q, want %q", n.ID, n.Role, want)
		}
	}
	bob.call(http.MethodPatch, api+"/nodes/"+inner.ID, obj{"suite": bob.suite, "sealed_metadata": b64([]byte("m"))}).wantStatus(t, http.StatusOK)
	bob.call(http.MethodPatch, api+"/nodes/"+weak.ID, obj{"suite": bob.suite, "sealed_metadata": b64([]byte("m"))}).wantError(t, http.StatusForbidden, "forbidden")
	// Editor on the folder, viewer on what holds it: the folder's own place stays put.
	bob.call(http.MethodPost, api+"/nodes/"+strong.ID+"/trash", nil).wantError(t, http.StatusForbidden, "forbidden")
}

func TestWhatIsAboveAGrantDoesNotShow(t *testing.T) {
	_, alice, bob := driveEnv(t, "e2e")
	root, folder, _ := sharedFolder(t, alice, bob, "viewer")
	var seen map[string]any
	resp := bob.call(http.MethodGet, api+"/nodes/"+folder.ID, nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &seen)
	if _, ok := seen["parent_id"]; ok {
		t.Errorf("parent shows: %s", resp.body)
	}
	if _, ok := seen["name_tag"]; ok {
		t.Errorf("name tag shows: %s", resp.body)
	}
	if seen["wrapped_key"] != "" {
		t.Errorf("wrapped key shows: %s", resp.body)
	}
	bob.call(http.MethodGet, api+"/nodes/"+root.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	child := alice.create(folder.ID, "file", "child")
	if got := bob.get(child.ID); got.ParentID != folder.ID || got.NameTag == "" || got.WrappedKey == nil || *got.WrappedKey == "" {
		t.Errorf("inside the grant: %+v", got)
	}
	if got := alice.get(folder.ID); got.ParentID != root.ID {
		t.Errorf("owner's view lost the parent: %+v", got)
	}
}

func TestDeepTreeResolves(t *testing.T) {
	e, alice, bob := driveEnv(t, "none")
	root := alice.root()
	top := alice.create(root.ID, "folder", "top")
	alice.share(top.ID, bob, "viewer")
	parent := top.ID
	for range store.MaxTreeDepth - 1 {
		n, err := e.st.CreateNode(ctx, store.Node{ID: store.NewID(), OwnerID: alice.id, ParentID: parent, Kind: store.KindFolder, Suite: noneSuite,
			SealedMetadata: []byte("m"), NameTag: fill(1, 32), CreatedAt: e.now()}, nil)
		if err != nil {
			t.Fatal(err)
		}
		parent = n.ID
	}
	bob.call(http.MethodGet, api+"/nodes/"+parent, nil).wantStatus(t, http.StatusOK)
	bob.call(http.MethodPost, api+"/nodes", bob.nodeRequest(parent, "file", "x")).wantError(t, http.StatusForbidden, "forbidden")
	alice.call(http.MethodPost, api+"/nodes", alice.nodeRequest(parent, "file", "x")).wantError(t, http.StatusConflict, "tree_too_deep")
	var access struct {
		Access []struct {
			Inherited bool `json:"inherited"`
		} `json:"access"`
	}
	resp := bob.call(http.MethodGet, api+"/nodes/"+parent+"/grants", nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &access)
	if len(access.Access) != 1 || !access.Access[0].Inherited {
		t.Errorf("access %s", resp.body)
	}
}

func TestTrashIsHiddenFromGrantees(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	root := alice.root()
	above := alice.create(root.ID, "folder", "above")
	folder := alice.create(above.ID, "folder", "folder")
	child := alice.create(folder.ID, "file", "child")
	v := alice.upload(child.ID, alice.frames(1500, 1))
	g := alice.share(folder.ID, bob, "editor")

	hidden := func(id string) {
		t.Helper()
		bob.call(http.MethodGet, api+"/nodes/"+id, nil).wantError(t, http.StatusNotFound, "not_found")
	}
	alice.call(http.MethodPost, api+"/nodes/"+child.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	hidden(child.ID)
	bob.call(http.MethodGet, api+"/blobs/"+v.BlobID, nil).wantError(t, http.StatusNotFound, "not_found")
	var page pageBody
	bob.call(http.MethodGet, api+"/nodes/"+folder.ID+"/children", nil).decode(t, &page)
	if len(page.Nodes) != 0 {
		t.Errorf("listed: %+v", page.Nodes)
	}
	alice.get(child.ID)
	alice.call(http.MethodPost, api+"/nodes/"+child.ID+"/restore", nil).wantStatus(t, http.StatusOK)

	// A folder above the grant goes in the trash: the grant shows nothing until it is back.
	alice.call(http.MethodPost, api+"/nodes/"+above.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	hidden(folder.ID)
	hidden(child.ID)
	var mine grantPageBody
	bob.call(http.MethodGet, api+"/shared-with-me", nil).decode(t, &mine)
	if len(mine.Items) != 0 {
		t.Errorf("listed from the trash: %+v", mine.Items)
	}
	var notes struct {
		Notifications []obj `json:"notifications"`
	}
	bob.call(http.MethodGet, api+"/notifications", nil).decode(t, &notes)
	if len(notes.Notifications) != 0 {
		t.Errorf("notified from the trash: %+v", notes)
	}
	// The holder can still walk away from it.
	alice.call(http.MethodPost, api+"/nodes/"+above.ID+"/restore", nil).wantStatus(t, http.StatusOK)
	bob.call(http.MethodGet, api+"/nodes/"+folder.ID, nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/nodes/"+above.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	bob.call(http.MethodDelete, api+"/grants/"+g.ID, nil).wantStatus(t, http.StatusNoContent)
}

func journalOf(t *testing.T, d *driveUser) []string {
	t.Helper()
	var page struct {
		Changes []struct {
			NodeID string `json:"node_id"`
			Op     string `json:"op"`
		} `json:"changes"`
	}
	resp := d.call(http.MethodGet, api+"/changes", nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &page)
	out := make([]string, 0, len(page.Changes))
	for _, c := range page.Changes {
		out = append(out, c.NodeID+" "+c.Op)
	}
	return out
}

func TestJournalCarriesSharedNodes(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	root, folder, g := sharedFolder(t, alice, bob, "editor")
	private := alice.create(root.ID, "file", "private")
	inside := alice.create(folder.ID, "file", "inside")
	byBob := bob.create(folder.ID, "file", "by-bob")
	alice.call(http.MethodPatch, api+"/grants/"+g.ID, obj{"role": "viewer", "signature": ""}).wantStatus(t, http.StatusOK)

	got := journalOf(t, bob)
	for _, want := range []string{folder.ID + " granted", inside.ID + " created", byBob.ID + " created", folder.ID + " role_changed"} {
		if !slices.Contains(got, want) {
			t.Errorf("no %q in %v", want, got)
		}
	}
	if slices.ContainsFunc(got, func(e string) bool { return strings.HasPrefix(e, private.ID) || strings.HasPrefix(e, root.ID) }) {
		t.Errorf("out of reach in the journal: %v", got)
	}
	if owner := journalOf(t, alice); !slices.Contains(owner, byBob.ID+" created") {
		t.Errorf("owner did not hear of an editor's work: %v", owner)
	}

	alice.call(http.MethodDelete, api+"/grants/"+g.ID, nil).wantStatus(t, http.StatusNoContent)
	if got := journalOf(t, bob); !slices.Contains(got, folder.ID+" revoked") {
		t.Errorf("no revocation in %v", got)
	}
	before := len(journalOf(t, bob))
	alice.create(folder.ID, "file", "after")
	if got := journalOf(t, bob); len(got) != before {
		t.Errorf("heard of what came after: %v", got)
	}
}

func TestJournalSaysWhenAMoveTakesANodeAway(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	root, folder, _ := sharedFolder(t, alice, bob, "viewer")
	x := alice.create(folder.ID, "file", "x")
	alice.call(http.MethodPost, api+"/nodes/"+x.ID+"/move", obj{"parent_id": root.ID, "wrapped_key": "", "name_tag": tagOf("x")}).wantStatus(t, http.StatusOK)
	got := journalOf(t, bob)
	if !slices.Contains(got, x.ID+" revoked") {
		t.Errorf("no revocation in %v", got)
	}
	if slices.Contains(got, x.ID+" moved") {
		t.Errorf("told of the move as well: %v", got)
	}
	bob.call(http.MethodGet, api+"/nodes/"+x.ID, nil).wantError(t, http.StatusNotFound, "not_found")
}

func rotateBody(d *driveUser, generation int64) obj {
	return obj{
		"key_generation": generation, "parent_key_generation": 1, "wrapped_key": d.wrapped(), "previous_key": d.sealedKey(),
		"sealed_metadata": b64([]byte("sealed again")), "children": []obj{}, "grants": []obj{},
	}
}

func TestRotate(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		_, folder, _ := sharedFolder(t, alice, bob, "editor")
		file := alice.create(folder.ID, "file", "file")
		old := alice.upload(file.ID, alice.frames(2000, 1))

		body := rotateBody(alice, 1)
		rotate := func(id string, b obj, who *driveUser) response {
			t.Helper()
			return who.call(http.MethodPost, api+"/nodes/"+id+"/rotate", b)
		}

		// Not what the folder has: a child and a grant are missing.
		rotate(folder.ID, body, alice).wantError(t, http.StatusConflict, "rotate_conflict")
		body["children"] = []obj{{"id": file.ID, "wrapped_key": alice.wrapped(), "name_tag": tagOf("file again")}}
		rotate(folder.ID, body, alice).wantError(t, http.StatusConflict, "rotate_conflict")
		grants := []obj{{"grantee_id": bob.id, "sealed_key": alice.sealedGrant(), "signature": alice.signature()}}
		body["grants"] = grants
		// An editor shares nothing, so rotates nothing.
		rotate(folder.ID, body, bob).wantError(t, http.StatusForbidden, "forbidden")
		rotate(folder.ID, obj{"key_generation": 2, "parent_key_generation": 1, "wrapped_key": alice.wrapped(), "previous_key": alice.sealedKey(),
			"sealed_metadata": body["sealed_metadata"], "children": body["children"], "grants": grants}, alice).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")

		resp := rotate(folder.ID, body, alice)
		resp.wantStatus(t, http.StatusOK)
		var n struct {
			KeyGeneration int64 `json:"key_generation"`
		}
		resp.decode(t, &n)
		if n.KeyGeneration != 2 {
			t.Errorf("generation %d", n.KeyGeneration)
		}
		if !e.audited("node_rotated") {
			t.Error("no audit row")
		}
		rotate(folder.ID, body, alice).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")

		var mine grantPageBody
		bob.call(http.MethodGet, api+"/shared-with-me", nil).decode(t, &mine)
		if mine.Items[0].Grant.KeyGeneration != 2 || mine.Items[0].Node.KeyGeneration != 2 {
			t.Errorf("grant after rotation %+v", mine.Items[0])
		}
		if got := bob.get(file.ID); got.NameTag != tagOf("file again") {
			t.Errorf("tag %s", got.NameTag)
		}
		if got := journalOf(t, bob); !slices.Contains(got, folder.ID+" rotated") {
			t.Errorf("no rotation in %v", got)
		}

		// Writes sealed under the old key of the folder are refused.
		stale := alice.nodeRequest(folder.ID, "file", "late")
		stale["parent_key_generation"] = 1
		alice.call(http.MethodPost, api+"/nodes", stale).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")
		stale["parent_key_generation"] = 2
		alice.call(http.MethodPost, api+"/nodes", stale).wantStatus(t, http.StatusCreated)

		// A file: versions keep their generation and a way to it.
		inflight := bob.frames(1500, 5)
		u := bob.startUpload(file.ID, inflight)
		for i, f := range inflight {
			bob.put(u.ID, i, f).wantStatus(t, http.StatusNoContent)
		}
		fileBody := rotateBody(alice, 1)
		fileBody["parent_key_generation"] = 2
		rotate(file.ID, fileBody, alice).wantStatus(t, http.StatusOK)

		bob.call(http.MethodPost, api+"/uploads/"+u.ID+"/commit", bob.commitBody()).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")
		bob.call(http.MethodDelete, api+"/uploads/"+u.ID, nil).wantStatus(t, http.StatusNoContent)
		req := bob.uploadRequest(file.ID, bob.frames(10, 1))
		req["key_generation"] = 1
		bob.call(http.MethodPost, api+"/uploads", req).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")

		var read struct {
			KeyGeneration int64 `json:"key_generation"`
			KeyChain      []struct {
				Generation int64  `json:"generation"`
				SealedKey  string `json:"sealed_key"`
			} `json:"key_chain"`
		}
		resp = bob.call(http.MethodGet, api+"/nodes/"+file.ID+"/versions/"+old.ID, nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &read)
		if read.KeyGeneration != 1 {
			t.Errorf("old version %s", resp.body)
		}
		if mode == "e2e" && (len(read.KeyChain) != 1 || read.KeyChain[0].Generation != 1 || read.KeyChain[0].SealedKey != alice.sealedKey()) {
			t.Errorf("chain %s", resp.body)
		}
		if mode == "none" && len(read.KeyChain) != 0 {
			t.Errorf("chain without keys %s", resp.body)
		}
		bob.call(http.MethodGet, api+"/blobs/"+old.BlobID, nil).wantStatus(t, http.StatusOK)
		fresh := alice.upload(file.ID, alice.frames(1000, 8))
		resp = alice.call(http.MethodGet, api+"/nodes/"+file.ID+"/versions/"+fresh.ID, nil)
		read.KeyChain = nil
		resp.decode(t, &read)
		if read.KeyGeneration != 2 || len(read.KeyChain) != 0 {
			t.Errorf("new version %s", resp.body)
		}
	})
}

func TestRotateChecksSizes(t *testing.T) {
	_, alice, bob := driveEnv(t, "e2e")
	_, folder, _ := sharedFolder(t, alice, bob, "viewer")
	for name, mod := range map[string]func(obj){
		"metadata": func(b obj) { b["sealed_metadata"] = "" },
		"previous": func(b obj) { b["previous_key"] = b64(fill(1, 72)) },
		"no key":   func(b obj) { b["wrapped_key"] = "" },
		"tag": func(b obj) {
			b["children"] = []obj{{"id": store.NewID(), "wrapped_key": alice.wrapped(), "name_tag": b64(fill(1, 31))}}
		},
		"grant": func(b obj) {
			b["grants"] = []obj{{"grantee_id": bob.id, "sealed_key": b64(fill(1, 73)), "signature": alice.signature()}}
		},
		"signature": func(b obj) {
			b["grants"] = []obj{{"grantee_id": bob.id, "sealed_key": alice.sealedGrant(), "signature": b64(fill(1, 12))}}
		},
	} {
		b := rotateBody(alice, 1)
		mod(b)
		if resp := alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/rotate", b); resp.status != http.StatusBadRequest || resp.code() != "invalid_rotation" {
			t.Errorf("%s: %d %s", name, resp.status, resp.body)
		}
	}
	b := rotateBody(alice, 1)
	b["children"] = []obj{{"id": "nope", "wrapped_key": alice.wrapped(), "name_tag": tagOf("x")}}
	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/rotate", b).wantError(t, http.StatusBadRequest, "invalid_id")

	root := alice.root()
	alice.call(http.MethodPost, api+"/nodes/"+root.ID+"/rotate", rotateBody(alice, 1)).wantError(t, http.StatusConflict, "root_immutable")
}

// Rotating removes a thumbnail, which has no generation of its own.
func TestRotateDropsTheThumbnail(t *testing.T) {
	_, alice, bob := driveEnv(t, "e2e")
	_, folder, _ := sharedFolder(t, alice, bob, "viewer")
	file := alice.create(folder.ID, "file", "file")
	thumb := store.NewID()
	data := fill(8, 200)
	alice.e.call(http.MethodPut, api+"/blobs/"+thumb+"?kind=thumb&suite="+alice.suite+"&node_id="+file.ID, string(data),
		"Cookie", alice.cookie, "X-Content-SHA256", sumB64(data)).wantStatus(t, http.StatusCreated)
	if got := alice.get(file.ID); got.ThumbBlobID != thumb {
		t.Fatalf("thumbnail %+v", got)
	}
	used, _ := alice.storage()
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/rotate", rotateBody(alice, 1)).wantStatus(t, http.StatusOK)
	if got := alice.get(file.ID); got.ThumbBlobID != "" {
		t.Errorf("thumbnail survived: %+v", got)
	}
	if now, _ := alice.storage(); now != used-200 {
		t.Errorf("used %d, was %d", now, used)
	}
}

// A folder's keys may not fit the ordinary cap on a JSON body.
func TestRotateTakesALargeFolder(t *testing.T) {
	_, alice, bob := driveEnv(t, "e2e")
	folder := alice.create(alice.root().ID, "folder", "large")
	alice.share(folder.ID, bob, "viewer")
	b := rotateBody(alice, 1)
	b["grants"] = []obj{{"grantee_id": bob.id, "sealed_key": alice.sealedGrant(), "signature": alice.signature()}}
	children := make([]obj, 0, 6000)
	for i := range 6000 {
		children = append(children, obj{"id": store.NewID(), "wrapped_key": alice.wrapped(), "name_tag": tagOf(fmt.Sprint(i))})
	}
	b["children"] = children
	data, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	if len(data) <= 1<<20 {
		t.Fatalf("only %d bytes", len(data))
	}
	// Past the ordinary cap, it reaches the check that the children are the node's.
	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/rotate", b).wantError(t, http.StatusConflict, "rotate_conflict")
	alice.call(http.MethodPatch, api+"/nodes/"+folder.ID, string(data)).wantError(t, http.StatusRequestEntityTooLarge, "too_large")
}

func TestLookupUser(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		var u struct {
			ID         string         `json:"id"`
			Username   string         `json:"username"`
			PublicKeys map[string]any `json:"public_keys"`
		}
		resp := alice.call(http.MethodGet, api+"/users/lookup?username=bob", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &u)
		if u.ID != bob.id || u.Username != "bob" {
			t.Errorf("found %+v", u)
		}
		if (u.PublicKeys != nil) != (mode == "e2e") {
			t.Errorf("keys in %s: %s", mode, resp.body)
		}
		alice.call(http.MethodGet, api+"/users/lookup?username=BOB", nil).wantStatus(t, http.StatusOK)
		for _, username := range []string{"bo", "b", "b%25", "nobody", "%20", "not%20valid"} {
			alice.call(http.MethodGet, api+"/users/lookup?username="+username, nil).wantError(t, http.StatusNotFound, "not_found")
		}
		e.call(http.MethodGet, api+"/users/lookup?username=bob", nil).wantError(t, http.StatusUnauthorized, "unauthorized")

		admin := e.login("root")
		admin.call(http.MethodPatch, api+"/admin/users/"+bob.id, obj{"disabled": true}).wantStatus(t, http.StatusOK)
		alice.call(http.MethodGet, api+"/users/lookup?username=bob", nil).wantError(t, http.StatusNotFound, "not_found")
	})
}

func TestLookupIsRateLimited(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 2})
	admin := e.login("root")
	limited := func(c *client) int {
		t.Helper()
		for i := range 100 {
			if resp := c.call(http.MethodGet, api+"/users/lookup?username=root", nil); resp.status == http.StatusTooManyRequests {
				return i
			}
		}
		t.Fatal("never limited")
		return 0
	}
	if got := limited(admin); got != 6 {
		t.Errorf("limited after %d", got)
	}
	e.advance(2 * time.Minute)
	admin.call(http.MethodGet, api+"/users/lookup?username=root", nil).wantStatus(t, http.StatusOK)
}

func TestNotifications(t *testing.T) {
	e, alice, bob := driveEnv(t, "e2e")
	_, one, g1 := sharedFolder(t, alice, bob, "viewer")
	two := alice.create(alice.root().ID, "folder", "two")
	g2 := alice.share(two.ID, bob, "editor")

	type list struct {
		Notifications []map[string]any `json:"notifications"`
		HasMore       bool             `json:"has_more"`
	}
	read := func(d *driveUser) list {
		t.Helper()
		var l list
		resp := d.call(http.MethodGet, api+"/notifications", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &l)
		return l
	}
	got := read(bob)
	if len(got.Notifications) != 2 || got.HasMore {
		t.Fatalf("notifications %+v", got)
	}
	for _, n := range got.Notifications {
		if n["granter_id"] != alice.id {
			t.Errorf("granter in %v", n)
		}
		for k := range n {
			if !slices.Contains([]string{"grant_id", "node_id", "granter_id", "created_at"}, k) {
				t.Errorf("more than ids: %v", n)
			}
		}
	}
	if len(read(alice).Notifications) != 0 {
		t.Error("the owner is told of what they shared")
	}

	// Someone else's read does not count.
	alice.call(http.MethodPost, api+"/notifications/read", obj{"grant_ids": []string{g1.ID, g2.ID}}).wantStatus(t, http.StatusNoContent)
	if len(read(bob).Notifications) != 2 {
		t.Error("another user marked them")
	}
	bob.call(http.MethodPost, api+"/notifications/read", obj{"grant_ids": []string{g1.ID}}).wantStatus(t, http.StatusNoContent)
	got = read(bob)
	if len(got.Notifications) != 1 || got.Notifications[0]["grant_id"] != g2.ID {
		t.Errorf("after one %+v", got)
	}
	bob.call(http.MethodPost, api+"/notifications/read", obj{"grant_ids": []string{"nope"}}).wantError(t, http.StatusBadRequest, "invalid_id")
	bob.call(http.MethodPost, api+"/notifications/read", obj{"grant_ids": []string{}}).wantStatus(t, http.StatusNoContent)
	if len(read(bob).Notifications) != 1 {
		t.Error("an empty list marked something")
	}
	bob.call(http.MethodPost, api+"/notifications/read", obj{}).wantStatus(t, http.StatusNoContent)
	if len(read(bob).Notifications) != 0 {
		t.Error("all did not mark all")
	}
	e.call(http.MethodGet, api+"/notifications", nil).wantError(t, http.StatusUnauthorized, "unauthorized")

	// A revoke and a new grant make a new notification.
	alice.call(http.MethodDelete, api+"/grants/"+g1.ID, nil).wantStatus(t, http.StatusNoContent)
	alice.share(one.ID, bob, "viewer")
	if len(read(bob).Notifications) != 1 {
		t.Error("a new grant did not notify")
	}
}

func TestNotificationListIsSmall(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	root := alice.root()
	for i := range 52 {
		alice.share(alice.create(root.ID, "file", fmt.Sprint(i)).ID, bob, "viewer")
	}
	var l struct {
		Notifications []obj `json:"notifications"`
		HasMore       bool  `json:"has_more"`
	}
	bob.call(http.MethodGet, api+"/notifications", nil).decode(t, &l)
	if len(l.Notifications) != 50 || !l.HasMore {
		t.Errorf("%d, more %v", len(l.Notifications), l.HasMore)
	}
}

func TestSharedPagesAreById(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	root := alice.root()
	for i := range 5 {
		alice.share(alice.create(root.ID, "file", fmt.Sprint(i)).ID, bob, "viewer")
	}
	for _, c := range []struct {
		who  *driveUser
		path string
	}{{bob, "/shared-with-me"}, {alice, "/grants"}} {
		seen, cursor := 0, ""
		for {
			path := api + c.path + "?limit=2"
			if cursor != "" {
				path += "&cursor=" + cursor
			}
			var page grantPageBody
			resp := c.who.call(http.MethodGet, path, nil)
			resp.wantStatus(t, http.StatusOK)
			resp.decode(t, &page)
			seen += len(page.Items)
			if page.NextCursor == "" {
				break
			}
			cursor = page.NextCursor
		}
		if seen != 5 {
			t.Errorf("%s: %d", c.path, seen)
		}
	}
	bob.call(http.MethodGet, api+"/shared-with-me?cursor=nope", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
}

func TestEditorsUploadsDoNotOutliveTheirAccess(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	root, folder, _ := sharedFolder(t, alice, bob, "editor")
	private := alice.create(root.ID, "folder", "private")
	sub := alice.create(folder.ID, "folder", "sub")
	inSub := bob.create(sub.ID, "file", "a")
	inFolder := bob.create(folder.ID, "file", "b")
	frames := bob.frames(100, 1)
	reserved := func() int64 {
		_, r := alice.storage()
		return r
	}

	// Moved out of the share, what the editor had going under it goes.
	moved := bob.startUpload(inSub.ID, frames)
	kept := bob.startUpload(inFolder.ID, frames)
	if reserved() != 200 {
		t.Fatalf("reserved %d", reserved())
	}
	alice.call(http.MethodPost, api+"/nodes/"+sub.ID+"/move", obj{"parent_id": private.ID, "wrapped_key": "", "name_tag": tagOf("sub")}).wantStatus(t, http.StatusOK)
	bob.call(http.MethodGet, api+"/uploads/"+moved.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	bob.call(http.MethodGet, api+"/uploads/"+kept.ID, nil).wantStatus(t, http.StatusOK)
	if reserved() != 100 {
		t.Errorf("after the move, reserved %d", reserved())
	}

	// Trashed, the rest goes too, and the owner's own stay.
	own := alice.startUpload(inFolder.ID, frames)
	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	bob.call(http.MethodGet, api+"/uploads/"+kept.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	alice.call(http.MethodGet, api+"/uploads/"+own.ID, nil).wantStatus(t, http.StatusOK)
	if reserved() != 100 {
		t.Errorf("after the trash, reserved %d", reserved())
	}
}

func TestAnUploadCanBeAbortedWhereverItIs(t *testing.T) {
	_, alice, bob := driveEnv(t, "none")
	_, folder, _ := sharedFolder(t, alice, bob, "editor")
	file := alice.create(folder.ID, "file", "f")
	frames := alice.frames(100, 1)
	u := alice.startUpload(file.ID, frames)
	bob.call(http.MethodDelete, api+"/uploads/"+u.ID, nil).wantError(t, http.StatusNotFound, "not_found")

	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	alice.call(http.MethodDelete, api+"/uploads/"+u.ID, nil).wantStatus(t, http.StatusNoContent)
	if _, reserved := alice.storage(); reserved != 0 {
		t.Errorf("reserved %d", reserved)
	}
}

// A grant or link the owner's client cannot verify is named to be dropped: the
// rotation deletes the grant and revokes the link instead of sealing to them,
// and counts them as named, so it is not a conflict for good.
func TestRotateDropsWhatTheOwnerCannotVerify(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		_, alice, bob := driveEnv(t, mode)
		_, folder, _ := sharedFolder(t, alice, bob, "viewer")
		l := alice.link(folder.ID)
		rotate := func(b obj) response {
			t.Helper()
			return alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/rotate", b)
		}
		b := rotateBody(alice, 1)
		// Leaving them out is a conflict, as before.
		rotate(b).wantError(t, http.StatusConflict, "rotate_conflict")
		b["drop_grants"] = []string{"nothex"}
		rotate(b).wantError(t, http.StatusBadRequest, "invalid_id")
		// A grantee with no grant here is not something to drop.
		b["drop_grants"] = []string{alice.id}
		b["drop_links"] = []string{l.ID}
		rotate(b).wantError(t, http.StatusConflict, "rotate_conflict")
		b["drop_grants"] = []string{bob.id}
		rotate(b).wantStatus(t, http.StatusOK)

		bob.call(http.MethodGet, api+"/nodes/"+folder.ID, nil).wantError(t, http.StatusNotFound, "not_found")
		var access struct {
			Access []obj `json:"access"`
		}
		resp := alice.call(http.MethodGet, api+"/nodes/"+folder.ID+"/grants", nil)
		resp.decode(t, &access)
		if len(access.Access) != 0 {
			t.Errorf("grants left: %s", resp.body)
		}
		alice.call(http.MethodGet, api+"/public/links/"+l.ID, nil).wantError(t, http.StatusGone, "link_revoked")
	})
}
