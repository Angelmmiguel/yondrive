package server_test

import (
	"bytes"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

type linkBody struct {
	ID            string `json:"id"`
	NodeID        string `json:"node_id"`
	KeyGeneration int64  `json:"key_generation"`
	SealedKey     string `json:"sealed_key"`
	HasPassword   bool   `json:"has_password"`
	DownloadCount int64  `json:"download_count"`
	RevokedAt     string `json:"revoked_at"`
}

type publicNodeBody struct {
	ID             string `json:"id"`
	ParentID       string `json:"parent_id"`
	WrappedKey     string `json:"wrapped_key"`
	CurrentVersion string `json:"current_version"`
	ThumbBlobID    string `json:"thumb_blob_id"`
}

type publicLinkBody struct {
	ID                 string          `json:"id"`
	State              string          `json:"state"`
	KDF                map[string]any  `json:"kdf"`
	PasswordWrappedKey string          `json:"password_wrapped_key"`
	Node               *publicNodeBody `json:"node"`
	SealedKey          string          `json:"sealed_key"`
	KeyGeneration      int64           `json:"key_generation"`
	Token              string          `json:"token"`
	TokenExpiresAt     string          `json:"token_expires_at"`
	DownloadsRemaining *int64          `json:"downloads_remaining"`
}

func (d *driveUser) linkRequest(node string, extra ...any) obj {
	req := obj{"id": store.NewID(), "node_id": node, "role": "view", "key_generation": 1, "sealed_key": d.sealedKey(), "owner_sealed_key": d.sealedKey()}
	for i := 0; i+1 < len(extra); i += 2 {
		req[extra[i].(string)] = extra[i+1]
	}
	return req
}

func (d *driveUser) link(node string, extra ...any) linkBody {
	d.e.t.Helper()
	resp := d.call(http.MethodPost, api+"/links", d.linkRequest(node, extra...))
	resp.wantStatus(d.e.t, http.StatusCreated)
	var l linkBody
	resp.decode(d.e.t, &l)
	return l
}

// passwordFor is the password field of a new link, whose auth key is key(label).
func (d *driveUser) passwordFor(label string) obj {
	p := obj{"kdf": kdf(7), "auth_key": b64(key(label))}
	if d.mode == "e2e" {
		p["wrapped_key"] = b64(fill(5, 73))
	}
	return p
}

func openLink(e *env, id string, header ...string) publicLinkBody {
	e.t.Helper()
	resp := e.call(http.MethodGet, api+"/public/links/"+id, nil, header...)
	resp.wantStatus(e.t, http.StatusOK)
	var l publicLinkBody
	resp.decode(e.t, &l)
	return l
}

// anon reads under a link with its token and nothing else.
func anon(e *env, method, path, token string, header ...string) response {
	e.t.Helper()
	return e.call(method, api+path, nil, append([]string{"X-Link-Token", token}, header...)...)
}

// linkTree is a folder with a link, and what is around and in it.
type linkTree struct {
	root, outside, folder, sub, file, other nodeBody
	version, old                            versionBody
	link                                    linkBody
	token                                   string
}

func newLinkTree(t *testing.T, e *env, alice *driveUser, extra ...any) linkTree {
	t.Helper()
	var tr linkTree
	tr.root = alice.root()
	tr.outside = alice.create(tr.root.ID, "file", "outside")
	tr.folder = alice.create(tr.root.ID, "folder", "folder")
	tr.sub = alice.create(tr.folder.ID, "folder", "sub")
	tr.file = alice.create(tr.sub.ID, "file", "file")
	tr.other = alice.create(tr.folder.ID, "file", "other")
	tr.old = alice.upload(tr.file.ID, alice.frames(2000, 1))
	tr.version = alice.upload(tr.file.ID, alice.frames(3000, 2))
	tr.link = alice.link(tr.folder.ID, extra...)
	tr.token = openLink(e, tr.link.ID).Token
	return tr
}

func TestLinkLifecycle(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		root := alice.root()
		folder := alice.create(root.ID, "folder", "f")
		l := alice.link(folder.ID, "download_limit", 3, "expires_at", e.now().Add(day).Format(time.RFC3339))
		if l.KeyGeneration != 1 || l.NodeID != folder.ID || l.SealedKey != alice.sealedKey() {
			t.Errorf("link %+v", l)
		}
		if !e.audited("link_created") {
			t.Error("no audit row")
		}

		var page struct {
			Items []struct {
				Link linkBody `json:"link"`
				Node nodeBody `json:"node"`
			} `json:"items"`
		}
		resp := alice.call(http.MethodGet, api+"/links", nil)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &page)
		if len(page.Items) != 1 || page.Items[0].Link.ID != l.ID || page.Items[0].Node.ID != folder.ID {
			t.Errorf("links %s", resp.body)
		}
		resp = bob.call(http.MethodGet, api+"/links", nil)
		resp.wantStatus(t, http.StatusOK)
		page.Items = nil
		resp.decode(t, &page)
		if len(page.Items) != 0 {
			t.Errorf("bob sees %s", resp.body)
		}
		bob.call(http.MethodPost, api+"/links/"+l.ID+"/revoke", nil).wantError(t, http.StatusNotFound, "not_found")
		bob.call(http.MethodDelete, api+"/links/"+l.ID, nil).wantError(t, http.StatusNotFound, "not_found")

		resp = alice.call(http.MethodPost, api+"/links/"+l.ID+"/revoke", nil)
		resp.wantStatus(t, http.StatusOK)
		var revoked linkBody
		resp.decode(t, &revoked)
		if revoked.RevokedAt == "" || !e.audited("link_revoked") {
			t.Errorf("revoked %+v", revoked)
		}
		e.call(http.MethodGet, api+"/public/links/"+l.ID, nil).wantError(t, http.StatusGone, "link_revoked")

		alice.call(http.MethodDelete, api+"/links/"+l.ID, nil).wantStatus(t, http.StatusNoContent)
		if !e.audited("link_deleted") {
			t.Error("no audit row for the deletion")
		}
		e.call(http.MethodGet, api+"/public/links/"+l.ID, nil).wantError(t, http.StatusNotFound, "not_found")
		alice.call(http.MethodDelete, api+"/links/"+l.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	})
}

func TestLinkRefusals(t *testing.T) {
	e, alice, bob := driveEnv(t, "e2e")
	root := alice.root()
	folder := alice.create(root.ID, "folder", "f")
	alice.share(folder.ID, bob, "editor")
	post := func(extra ...any) response {
		return alice.call(http.MethodPost, api+"/links", alice.linkRequest(folder.ID, extra...))
	}

	post("role", "edit").wantError(t, http.StatusBadRequest, "invalid_link")
	post("id", "nope").wantError(t, http.StatusBadRequest, "invalid_id")
	post("sealed_key", b64(fill(1, 72))).wantError(t, http.StatusBadRequest, "invalid_link")
	post("sealed_key", "").wantError(t, http.StatusBadRequest, "invalid_link")
	post("owner_sealed_key", "").wantError(t, http.StatusBadRequest, "invalid_link")
	post("expires_at", e.now().Add(-time.Hour).Format(time.RFC3339)).wantError(t, http.StatusBadRequest, "invalid_link")
	post("download_limit", 0).wantError(t, http.StatusBadRequest, "invalid_link")
	post("key_generation", 2).wantError(t, http.StatusPreconditionFailed, "key_generation_conflict")
	post("node_id", root.ID).wantError(t, http.StatusConflict, "root_immutable")
	post("password", obj{"kdf": kdf(1), "auth_key": b64(fill(1, 31)), "wrapped_key": b64(fill(1, 73))}).wantError(t, http.StatusBadRequest, "invalid_link")
	post("password", obj{"kdf": kdf(1), "auth_key": b64(fill(1, 32))}).wantError(t, http.StatusBadRequest, "invalid_link")
	post("password", obj{"kdf": obj{"name": "argon2id", "m": 1, "t": 1, "p": 1, "salt": b64(fill(1, 16))}, "auth_key": b64(fill(1, 32)), "wrapped_key": b64(fill(1, 73))}).wantError(t, http.StatusBadRequest, "invalid_kdf")

	bob.call(http.MethodPost, api+"/links", bob.linkRequest(folder.ID)).wantError(t, http.StatusForbidden, "forbidden")
	id := store.NewID()
	post("id", id).wantStatus(t, http.StatusCreated)
	post("id", id).wantError(t, http.StatusConflict, "id_taken")

	alice.call(http.MethodPost, api+"/nodes/"+folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	post().wantError(t, http.StatusConflict, "node_trashed")
}

func TestLinkBlobsFollowTheMode(t *testing.T) {
	_, alice, _ := driveEnv(t, "none")
	folder := alice.create(alice.root().ID, "folder", "f")
	alice.call(http.MethodPost, api+"/links", alice.linkRequest(folder.ID, "sealed_key", b64(fill(1, 73)))).wantError(t, http.StatusBadRequest, "invalid_link")
	alice.call(http.MethodPost, api+"/links", alice.linkRequest(folder.ID, "password",
		obj{"kdf": kdf(1), "auth_key": b64(fill(1, 32)), "wrapped_key": b64(fill(1, 73))})).wantError(t, http.StatusBadRequest, "invalid_link")
}

func TestPublicLinkExposesNoOwner(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		tr := newLinkTree(t, e, alice)
		for _, resp := range []response{
			e.call(http.MethodGet, api+"/public/links/"+tr.link.ID, nil),
			anon(e, http.MethodGet, "/public/links/"+tr.link.ID+"/nodes/"+tr.folder.ID, tr.token),
			anon(e, http.MethodGet, "/public/links/"+tr.link.ID+"/nodes/"+tr.folder.ID+"/children", tr.token),
			anon(e, http.MethodGet, "/public/links/"+tr.link.ID+"/nodes/"+tr.file.ID+"/version", tr.token),
		} {
			resp.wantStatus(t, http.StatusOK)
			text := string(resp.body)
			for _, secret := range []string{alice.id, "alice", "owner_id", "quota", "used_bytes", "reserved", "trashed_at", "author_id", tr.root.ID} {
				if strings.Contains(text, secret) {
					t.Errorf("%q in %s", secret, text)
				}
			}
			if got := resp.header.Get("Referrer-Policy"); got != "no-referrer" {
				t.Errorf("Referrer-Policy %q", got)
			}
			if got := resp.header.Get("Set-Cookie"); got != "" {
				t.Errorf("Set-Cookie %q", got)
			}
		}
	})
}

func TestReferrerPolicyOnPublicPages(t *testing.T) {
	e := configured(t, "none", server.Config{UI: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })})
	resp := e.call(http.MethodGet, "/s/"+store.NewID(), nil)
	resp.wantStatus(t, http.StatusOK)
	if got := resp.header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Errorf("Referrer-Policy %q", got)
	}
}

func TestPublicLinkReadsTheSubtree(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		tr := newLinkTree(t, e, alice)
		base := "/public/links/" + tr.link.ID

		doc := openLink(e, tr.link.ID)
		if doc.State != "open" || doc.Node == nil || doc.Node.ID != tr.folder.ID || doc.SealedKey != alice.sealedKey() || doc.KeyGeneration != 1 || doc.Token == "" || doc.TokenExpiresAt == "" {
			t.Fatalf("open %+v", doc)
		}
		if doc.Node.ParentID != "" || doc.Node.WrappedKey != "" {
			t.Errorf("the link's node shows what is above it: %+v", doc.Node)
		}

		var page struct {
			Nodes []publicNodeBody `json:"nodes"`
		}
		resp := anon(e, http.MethodGet, base+"/nodes/"+tr.folder.ID+"/children", tr.token)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &page)
		if len(page.Nodes) != 2 {
			t.Fatalf("children %s", resp.body)
		}
		for _, n := range page.Nodes {
			if n.ParentID != tr.folder.ID || n.WrappedKey != alice.wrapped() {
				t.Errorf("child %+v", n)
			}
		}

		var v struct {
			BlobID string `json:"blob_id"`
			Author string `json:"author_public_key"`
			Hashes string `json:"frame_hashes"`
		}
		resp = anon(e, http.MethodGet, base+"/nodes/"+tr.file.ID+"/version", tr.token)
		resp.wantStatus(t, http.StatusOK)
		resp.decode(t, &v)
		if v.BlobID != tr.version.BlobID || v.Hashes == "" {
			t.Errorf("version %s", resp.body)
		}
		if (v.Author != "") != (mode == "e2e") {
			t.Errorf("author key in %s: %s", mode, resp.body)
		}
		anon(e, http.MethodGet, base+"/nodes/"+tr.folder.ID+"/version", tr.token).wantError(t, http.StatusNotFound, "not_found")

		resp = anon(e, http.MethodGet, base+"/blobs/"+tr.version.BlobID, tr.token, "Range", "bytes=0-9")
		resp.wantStatus(t, http.StatusPartialContent)
		if len(resp.body) != 10 {
			t.Errorf("range %d", len(resp.body))
		}
		if resp.header.Get("Content-Disposition") != "attachment" || resp.header.Get("Cache-Control") != "private, no-store" {
			t.Errorf("headers %v", resp.header)
		}
		resp = anon(e, http.MethodGet, base+"/blobs/"+tr.version.BlobID, tr.token)
		resp.wantStatus(t, http.StatusOK)
		if int64(len(resp.body)) != tr.version.StoredSize {
			t.Errorf("whole file %d", len(resp.body))
		}
	})
}

func TestLinkTokenScope(t *testing.T) {
	e, alice, bob := driveEnv(t, "e2e")
	tr := newLinkTree(t, e, alice)
	base := "/public/links/" + tr.link.ID
	notFound := func(r response) {
		t.Helper()
		r.wantError(t, http.StatusNotFound, "not_found")
	}

	// Outside the subtree, above it, and nowhere.
	for _, id := range []string{tr.outside.ID, tr.root.ID, store.NewID()} {
		notFound(anon(e, http.MethodGet, base+"/nodes/"+id, tr.token))
		notFound(anon(e, http.MethodGet, base+"/nodes/"+id+"/children", tr.token))
		notFound(anon(e, http.MethodGet, base+"/nodes/"+id+"/version", tr.token))
	}
	anon(e, http.MethodGet, base+"/nodes/nope", tr.token).wantError(t, http.StatusBadRequest, "invalid_id")

	// The blob of a node outside, of another user, and of another version.
	outsideVersion := alice.upload(tr.outside.ID, alice.frames(1500, 3))
	notFound(anon(e, http.MethodGet, base+"/blobs/"+outsideVersion.BlobID, tr.token))
	bobsFile := bob.create(bob.root().ID, "file", "bobs")
	bobsVersion := bob.upload(bobsFile.ID, bob.frames(1500, 4))
	notFound(anon(e, http.MethodGet, base+"/blobs/"+bobsVersion.BlobID, tr.token))
	notFound(anon(e, http.MethodGet, base+"/blobs/"+tr.old.BlobID, tr.token))
	notFound(anon(e, http.MethodGet, base+"/nodes/"+bobsFile.ID, tr.token))

	// An index segment hangs off no node.
	index := store.NewID()
	data := fill(6, 100)
	alice.e.call(http.MethodPut, api+"/blobs/"+index+"?kind=index&suite="+alice.suite, string(data),
		"Cookie", alice.cookie, "X-Content-SHA256", sumB64(data)).wantStatus(t, http.StatusCreated)
	notFound(anon(e, http.MethodGet, base+"/blobs/"+index, tr.token))

	// A token opens one link, and no other.
	second := alice.create(tr.root.ID, "file", "second")
	other := alice.link(second.ID)
	otherBase := "/public/links/" + other.ID
	anon(e, http.MethodGet, otherBase+"/nodes/"+second.ID, tr.token).wantError(t, http.StatusUnauthorized, "link_token_invalid")
	anon(e, http.MethodGet, base+"/nodes/"+tr.folder.ID, openLink(e, other.ID).Token).wantError(t, http.StatusUnauthorized, "link_token_invalid")

	// A token someone altered, or made up.
	tampered := tr.token[:len(tr.token)-2] + "xx"
	for _, token := range []string{"nonsense", tampered, "v1." + tr.link.ID + "." + tr.outside.ID + ".s.9999999999.9999999999.mac"} {
		anon(e, http.MethodGet, base+"/nodes/"+tr.folder.ID, token).wantError(t, http.StatusUnauthorized, "link_token_invalid")
	}
}

func TestLinkAuthorityIsOnlyTheToken(t *testing.T) {
	e, alice, bob := driveEnv(t, "e2e")
	tr := newLinkTree(t, e, alice)
	base := api + "/public/links/" + tr.link.ID
	nodePath := base + "/nodes/" + tr.folder.ID

	// No token, whatever else comes: the owner's cookie, a grantee's, a device token.
	e.call(http.MethodGet, nodePath, nil).wantError(t, http.StatusUnauthorized, "link_token_required")
	e.call(http.MethodGet, nodePath, nil, "Cookie", alice.cookie).wantError(t, http.StatusUnauthorized, "link_token_required")
	e.call(http.MethodGet, nodePath, nil, "Cookie", bob.cookie).wantError(t, http.StatusUnauthorized, "link_token_required")
	e.call(http.MethodGet, nodePath, nil, "Authorization", "Bearer "+tr.token).wantError(t, http.StatusUnauthorized, "link_token_required")
	var created struct {
		Secret string `json:"secret"`
	}
	resp := alice.call(http.MethodPost, api+"/me/tokens", obj{"name": "laptop", "current_auth_key": b64(key("alice"))})
	resp.wantStatus(t, http.StatusCreated)
	resp.decode(t, &created)
	e.call(http.MethodGet, nodePath, nil, "Authorization", "Bearer "+created.Secret).wantError(t, http.StatusUnauthorized, "link_token_required")
	e.call(http.MethodGet, nodePath, nil, "X-Link-Token", created.Secret).wantError(t, http.StatusUnauthorized, "link_token_invalid")

	// A cookie gives nothing beyond what the token reaches.
	e.call(http.MethodGet, base+"/nodes/"+tr.outside.ID, nil, "X-Link-Token", tr.token, "Cookie", alice.cookie).wantError(t, http.StatusNotFound, "not_found")

	// A link token is nothing on the drive's routes.
	for _, h := range [][]string{{"X-Link-Token", tr.token}, {"Authorization", "Bearer " + tr.token}, {"Cookie", "yondrive_session=" + tr.token}} {
		e.call(http.MethodGet, api+"/nodes/"+tr.folder.ID, nil, h...).wantError(t, http.StatusUnauthorized, "unauthorized")
		e.call(http.MethodGet, api+"/blobs/"+tr.version.BlobID, nil, h...).wantError(t, http.StatusUnauthorized, "unauthorized")
		e.call(http.MethodGet, api+"/me", nil, h...).wantError(t, http.StatusUnauthorized, "unauthorized")
	}

	// A link is read only: nothing writes under it.
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		if resp := anon(e, method, "/public/links/"+tr.link.ID+"/nodes/"+tr.folder.ID, tr.token); resp.status != http.StatusNotFound && resp.status != http.StatusMethodNotAllowed {
			t.Errorf("%s: %d", method, resp.status)
		}
	}
}

func TestTrashIsHiddenFromLinks(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	tr := newLinkTree(t, e, alice)
	base := "/public/links/" + tr.link.ID
	notFound := func(r response) {
		t.Helper()
		r.wantError(t, http.StatusNotFound, "not_found")
	}

	alice.call(http.MethodPost, api+"/nodes/"+tr.file.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	notFound(anon(e, http.MethodGet, base+"/nodes/"+tr.file.ID, tr.token))
	notFound(anon(e, http.MethodGet, base+"/nodes/"+tr.file.ID+"/version", tr.token))
	notFound(anon(e, http.MethodGet, base+"/blobs/"+tr.version.BlobID, tr.token))
	var page struct {
		Nodes []publicNodeBody `json:"nodes"`
	}
	anon(e, http.MethodGet, base+"/nodes/"+tr.sub.ID+"/children", tr.token).decode(t, &page)
	if len(page.Nodes) != 0 {
		t.Errorf("listed: %+v", page.Nodes)
	}
	alice.call(http.MethodPost, api+"/nodes/"+tr.file.ID+"/restore", nil).wantStatus(t, http.StatusOK)

	// The folder between goes: what is under it goes too.
	alice.call(http.MethodPost, api+"/nodes/"+tr.sub.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	notFound(anon(e, http.MethodGet, base+"/nodes/"+tr.file.ID, tr.token))
	notFound(anon(e, http.MethodGet, base+"/blobs/"+tr.version.BlobID, tr.token))
	alice.call(http.MethodPost, api+"/nodes/"+tr.sub.ID+"/restore", nil).wantStatus(t, http.StatusOK)

	// The link's node goes: the whole link does.
	alice.call(http.MethodPost, api+"/nodes/"+tr.folder.ID+"/trash", nil).wantStatus(t, http.StatusOK)
	notFound(e.call(http.MethodGet, api+base, nil))
	notFound(anon(e, http.MethodGet, base+"/nodes/"+tr.other.ID, tr.token))
	alice.call(http.MethodPost, api+"/nodes/"+tr.folder.ID+"/restore", nil).wantStatus(t, http.StatusOK)
	anon(e, http.MethodGet, base+"/nodes/"+tr.other.ID, tr.token).wantStatus(t, http.StatusOK)

	// A move out of the subtree takes it out of the link's reach.
	alice.call(http.MethodPost, api+"/nodes/"+tr.other.ID+"/move", obj{"parent_id": tr.root.ID, "wrapped_key": "", "name_tag": tagOf("other")}).wantStatus(t, http.StatusOK)
	notFound(anon(e, http.MethodGet, base+"/nodes/"+tr.other.ID, tr.token))
}

func TestLinkExpiry(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	tr := newLinkTree(t, e, alice, "expires_at", time.Unix(1_800_000_000, 0).UTC().Add(time.Hour).Format(time.RFC3339))
	base := "/public/links/" + tr.link.ID
	anon(e, http.MethodGet, base+"/nodes/"+tr.folder.ID, tr.token).wantStatus(t, http.StatusOK)
	e.advance(time.Hour)
	e.call(http.MethodGet, api+base, nil).wantError(t, http.StatusGone, "link_expired")
}

func TestLinkTokenExpiresAndRenews(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	tr := newLinkTree(t, e, alice)
	base := "/public/links/" + tr.link.ID
	path := base + "/nodes/" + tr.folder.ID

	e.advance(14 * time.Minute)
	renewed := openLink(e, tr.link.ID, "X-Link-Token", tr.token)
	if renewed.Token == "" {
		t.Fatal("no renewal")
	}
	e.advance(2 * time.Minute)
	anon(e, http.MethodGet, path, tr.token).wantError(t, http.StatusUnauthorized, "link_token_invalid")
	anon(e, http.MethodGet, path, renewed.Token).wantStatus(t, http.StatusOK)

	// However often renewed, a session ends.
	token := renewed.Token
	for range 200 {
		e.advance(10 * time.Minute)
		doc := openLink(e, tr.link.ID, "X-Link-Token", token)
		anon(e, http.MethodGet, path, doc.Token).wantStatus(t, http.StatusOK)
		token = doc.Token
	}
	if got := sessionOf(token); got == sessionOf(renewed.Token) {
		t.Error("a session outlived its day")
	}
}

func sessionOf(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) != 7 {
		return ""
	}
	return parts[3]
}

func TestRevokedLinkEndsTokensAtOnce(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	tr := newLinkTree(t, e, alice)
	base := "/public/links/" + tr.link.ID
	anon(e, http.MethodGet, base+"/blobs/"+tr.version.BlobID, tr.token).wantStatus(t, http.StatusOK)
	alice.call(http.MethodPost, api+"/links/"+tr.link.ID+"/revoke", nil).wantStatus(t, http.StatusOK)
	anon(e, http.MethodGet, base+"/nodes/"+tr.folder.ID, tr.token).wantError(t, http.StatusGone, "link_revoked")
	anon(e, http.MethodGet, base+"/blobs/"+tr.version.BlobID, tr.token).wantError(t, http.StatusGone, "link_revoked")
	e.call(http.MethodGet, api+base, nil, "X-Link-Token", tr.token).wantError(t, http.StatusGone, "link_revoked")
}

func TestDisabledOwnerStopsLinks(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	tr := newLinkTree(t, e, alice)
	admin := e.login("root")
	admin.call(http.MethodPatch, api+"/admin/users/"+alice.id, obj{"disabled": true}).wantStatus(t, http.StatusOK)
	e.call(http.MethodGet, api+"/public/links/"+tr.link.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	anon(e, http.MethodGet, "/public/links/"+tr.link.ID+"/nodes/"+tr.folder.ID, tr.token).wantError(t, http.StatusNotFound, "not_found")
}

func TestDownloadLimitHoldsUnderRace(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	tr := newLinkTree(t, e, alice, "download_limit", 3)
	path := api + "/public/links/" + tr.link.ID + "/blobs/" + tr.version.BlobID

	tokens := make([]string, 20)
	for i := range tokens {
		tokens[i] = openLink(e, tr.link.ID).Token
	}
	var wg sync.WaitGroup
	var served, refused atomic.Int32
	for _, token := range tokens {
		wg.Go(func() {
			req, err := http.NewRequest(http.MethodGet, e.ts.URL+path, nil)
			if err != nil {
				t.Error(err)
				return
			}
			req.Header.Set("X-Link-Token", token)
			resp, err := e.ts.Client().Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			defer func() { _ = resp.Body.Close() }()
			switch resp.StatusCode {
			case http.StatusOK:
				served.Add(1)
			case http.StatusGone:
				refused.Add(1)
			default:
				t.Errorf("status %d", resp.StatusCode)
			}
		})
	}
	wg.Wait()
	if served.Load() != 3 || refused.Load() != 17 {
		t.Errorf("served %d, refused %d, limit 3", served.Load(), refused.Load())
	}
	e.call(http.MethodGet, api+"/public/links/"+tr.link.ID, nil).wantError(t, http.StatusGone, "link_limit_reached")
	var page struct {
		Items []struct {
			Link linkBody `json:"link"`
		} `json:"items"`
	}
	alice.call(http.MethodGet, api+"/links", nil).decode(t, &page)
	if page.Items[0].Link.DownloadCount != 3 {
		t.Errorf("count %d", page.Items[0].Link.DownloadCount)
	}
}

func TestDownloadCountsOncePerSessionAndFile(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	tr := newLinkTree(t, e, alice, "download_limit", 2)
	base := "/public/links/" + tr.link.ID
	blob := base + "/blobs/" + tr.version.BlobID

	remaining := func(token string) int64 {
		t.Helper()
		doc := openLink(e, tr.link.ID, "X-Link-Token", token)
		if doc.DownloadsRemaining == nil {
			t.Fatal("no count")
		}
		return *doc.DownloadsRemaining
	}
	if got := remaining(tr.token); got != 2 {
		t.Errorf("remaining %d", got)
	}
	for _, r := range []string{"bytes=0-99", "bytes=100-199", "bytes=500-"} {
		anon(e, http.MethodGet, blob, tr.token, "Range", r).wantStatus(t, http.StatusPartialContent)
	}
	anon(e, http.MethodGet, blob, tr.token).wantStatus(t, http.StatusOK)
	if got := remaining(tr.token); got != 1 {
		t.Errorf("after four reads of one file, remaining %d", got)
	}

	// A renewed token is the same session.
	renewed := openLink(e, tr.link.ID, "X-Link-Token", tr.token).Token
	anon(e, http.MethodGet, blob, renewed, "Range", "bytes=0-9").wantStatus(t, http.StatusPartialContent)
	if got := remaining(tr.token); got != 1 {
		t.Errorf("after renewing, remaining %d", got)
	}

	// Not starting at zero does not get around it.
	second := openLink(e, tr.link.ID).Token
	anon(e, http.MethodGet, blob, second, "Range", "bytes=1000-1001").wantStatus(t, http.StatusPartialContent)
	if got := remaining(second); got != 0 {
		t.Errorf("after a second session, remaining %d", got)
	}

	// Metadata and the sessions already going carry on, and new files and people do not.
	third := alice.upload(tr.other.ID, alice.frames(1500, 9))
	anon(e, http.MethodGet, base+"/blobs/"+third.BlobID, tr.token).wantError(t, http.StatusGone, "link_limit_reached")
	anon(e, http.MethodGet, blob, tr.token, "Range", "bytes=0-9").wantStatus(t, http.StatusPartialContent)
	anon(e, http.MethodGet, base+"/nodes/"+tr.folder.ID, tr.token).wantStatus(t, http.StatusOK)
	e.call(http.MethodGet, api+base, nil).wantError(t, http.StatusGone, "link_limit_reached")
	e.call(http.MethodGet, api+base, nil, "X-Link-Token", tr.token).wantStatus(t, http.StatusOK)

	if err := e.srv.Sweep(ctx); err != nil {
		t.Error(err)
	}
}

func TestThumbnailsDoNotCount(t *testing.T) {
	e, alice, _ := driveEnv(t, "e2e")
	tr := newLinkTree(t, e, alice, "download_limit", 1)
	thumb := store.NewID()
	data := fill(8, 64)
	alice.e.call(http.MethodPut, api+"/blobs/"+thumb+"?kind=thumb&suite="+alice.suite+"&node_id="+tr.file.ID, string(data),
		"Cookie", alice.cookie, "X-Content-SHA256", sumB64(data)).wantStatus(t, http.StatusCreated)
	base := "/public/links/" + tr.link.ID
	resp := anon(e, http.MethodGet, base+"/blobs/"+thumb, tr.token)
	resp.wantStatus(t, http.StatusOK)
	if !bytes.Equal(resp.body, data) {
		t.Error("wrong bytes")
	}
	doc := openLink(e, tr.link.ID, "X-Link-Token", tr.token)
	if *doc.DownloadsRemaining != 1 {
		t.Errorf("remaining %d", *doc.DownloadsRemaining)
	}
}

func TestLinkPassword(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, _ := driveEnv(t, mode)
		folder := alice.create(alice.root().ID, "folder", "f")
		l := alice.link(folder.ID, "password", alice.passwordFor("right"))
		if !l.HasPassword {
			t.Error("no password")
		}
		base := "/public/links/" + l.ID

		doc := openLink(e, l.ID)
		if doc.State != "password_required" || doc.KDF == nil || doc.Node != nil || doc.Token != "" || doc.SealedKey != "" {
			t.Errorf("before the password %+v", doc)
		}
		// Nothing to attack offline comes before the password has been shown.
		if doc.PasswordWrappedKey != "" {
			t.Errorf("wrapped key before the password: %+v", doc)
		}
		e.call(http.MethodGet, api+base+"/nodes/"+folder.ID, nil).wantError(t, http.StatusUnauthorized, "link_token_required")

		for _, wrong := range []obj{{"auth_key": b64(key("wrong"))}, {"auth_key": b64(fill(1, 3))}, {"auth_key": ""}} {
			resp := e.call(http.MethodPost, api+base+"/unlock", wrong)
			resp.wantError(t, http.StatusUnauthorized, "link_password_invalid")
			if strings.Contains(string(resp.body), "wrapped") {
				t.Errorf("a wrong password got %s", resp.body)
			}
		}
		if !e.audited("link_unlock_failed") {
			t.Error("no audit row for the failure")
		}

		resp := e.call(http.MethodPost, api+base+"/unlock", obj{"auth_key": b64(key("right"))})
		resp.wantStatus(t, http.StatusOK)
		var open publicLinkBody
		resp.decode(t, &open)
		if open.State != "open" || open.Node == nil || open.Token == "" || open.SealedKey != alice.sealedKey() {
			t.Errorf("after the password %+v", open)
		}
		wantWrapped := ""
		if mode == "e2e" {
			wantWrapped = b64(fill(5, 73))
		}
		if open.PasswordWrappedKey != wantWrapped {
			t.Errorf("wrapped key after the password in %s: %+v", mode, open)
		}
		if !e.audited("link_unlocked") {
			t.Error("no audit row for the success")
		}
		anon(e, http.MethodGet, base+"/nodes/"+folder.ID, open.Token).wantStatus(t, http.StatusOK)

		// The token goes on past the password, and renewing needs none.
		renewed := openLink(e, l.ID, "X-Link-Token", open.Token)
		if renewed.State != "open" || renewed.PasswordWrappedKey != wantWrapped {
			t.Errorf("renewal %+v", renewed)
		}
		if body := string(resp.body); strings.Contains(body, b64(key("right"))) {
			t.Errorf("the auth key came back: %s", body)
		}
	})
}

func TestUnlockIsSameOrigin(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	folder := alice.create(alice.root().ID, "folder", "f")
	l := alice.link(folder.ID, "password", alice.passwordFor("right"))
	e.call(http.MethodPost, api+"/public/links/"+l.ID+"/unlock", obj{"auth_key": b64(key("right"))},
		"Sec-Fetch-Site", "cross-site").wantError(t, http.StatusForbidden, "forbidden")
}

func TestLinkPasswordLimiter(t *testing.T) {
	loopback := netip.MustParsePrefix("127.0.0.1/32")
	e := configured(t, "none", server.Config{LoginAttempts: 3, TrustedProxies: []netip.Prefix{loopback}})
	admin := e.login("root")
	admin.call(http.MethodPatch, api+"/admin/settings", obj{"default_quota_bytes": 0}).wantStatus(t, http.StatusOK)
	alice := newDriveUser(e, admin, "alice", "none")
	folder := alice.create(alice.root().ID, "folder", "f")
	l := alice.link(folder.ID, "password", alice.passwordFor("right"))
	unlock := api + "/public/links/" + l.ID + "/unlock"
	wrong := obj{"auth_key": b64(key("wrong"))}
	right := obj{"auth_key": b64(key("right"))}
	from := func(address string) []string { return []string{"X-Forwarded-For", address} }

	// Per address: every attempt counts, and then even the right one is refused.
	for range 3 {
		e.call(http.MethodPost, unlock, wrong, from("10.0.0.1")...).wantError(t, http.StatusUnauthorized, "link_password_invalid")
	}
	e.call(http.MethodPost, unlock, right, from("10.0.0.1")...).wantError(t, http.StatusTooManyRequests, "rate_limited")
	e.call(http.MethodGet, api+"/public/links/"+l.ID, nil, from("10.0.0.1")...).wantError(t, http.StatusTooManyRequests, "rate_limited")

	// Another address is not held up by that...
	e.call(http.MethodPost, unlock, right, from("10.0.0.2")...).wantStatus(t, http.StatusOK)

	// ...until the link itself has had enough, however many addresses ask.
	for i := range 11 {
		e.call(http.MethodPost, unlock, wrong, from("10.0.1."+string(rune('1'+i%9)))...)
	}
	e.call(http.MethodPost, unlock, right, from("10.0.2.1")...).wantError(t, http.StatusTooManyRequests, "rate_limited")

	// A window later, all is well, and the limit on one link is not on another.
	second := alice.link(alice.create(folder.ID, "file", "x").ID, "password", alice.passwordFor("right"))
	e.call(http.MethodPost, api+"/public/links/"+second.ID+"/unlock", right, from("10.0.3.1")...).wantStatus(t, http.StatusOK)
	e.advance(2 * time.Minute)
	e.call(http.MethodPost, unlock, right, from("10.0.0.1")...).wantStatus(t, http.StatusOK)
}

func TestOpeningLinksIsLimitedPerAddress(t *testing.T) {
	e := configured(t, "none", server.Config{LoginAttempts: 1})
	for range 6 {
		e.call(http.MethodGet, api+"/public/links/"+store.NewID(), nil).wantError(t, http.StatusNotFound, "not_found")
	}
	e.call(http.MethodGet, api+"/public/links/"+store.NewID(), nil).wantError(t, http.StatusTooManyRequests, "rate_limited")
	e.call(http.MethodGet, api+"/public/links/nope", nil).wantError(t, http.StatusTooManyRequests, "rate_limited")
}

func TestPublicRoutesNeedASetupServer(t *testing.T) {
	e := newEnv(t, server.Config{})
	e.call(http.MethodGet, api+"/public/links/"+store.NewID(), nil).wantError(t, http.StatusConflict, "not_setup")
}

func TestRotationCarriesLinks(t *testing.T) {
	e, alice, _ := driveEnv(t, "e2e")
	file := alice.create(alice.root().ID, "file", "file")
	old := alice.upload(file.ID, alice.frames(1500, 1))
	live := alice.link(file.ID)
	ended := alice.link(file.ID)
	alice.call(http.MethodPost, api+"/links/"+ended.ID+"/revoke", nil).wantStatus(t, http.StatusOK)
	token := openLink(e, live.ID).Token

	body := rotateBody(alice, 1)
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/rotate", body).wantError(t, http.StatusConflict, "rotate_conflict")
	body["links"] = []obj{{"id": store.NewID(), "sealed_key": alice.sealedKey()}}
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/rotate", body).wantError(t, http.StatusConflict, "rotate_conflict")
	body["links"] = []obj{{"id": live.ID, "sealed_key": b64(fill(1, 72))}}
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/rotate", body).wantError(t, http.StatusBadRequest, "invalid_rotation")
	newKey := b64(fill(9, 73))
	body["links"] = []obj{{"id": live.ID, "sealed_key": newKey}, {"id": ended.ID, "sealed_key": newKey}}
	alice.call(http.MethodPost, api+"/nodes/"+file.ID+"/rotate", body).wantStatus(t, http.StatusOK)

	doc := openLink(e, live.ID, "X-Link-Token", token)
	if doc.KeyGeneration != 2 || doc.SealedKey != newKey {
		t.Errorf("link after rotation %+v", doc)
	}
	var v struct {
		BlobID        string `json:"blob_id"`
		KeyGeneration int64  `json:"key_generation"`
		KeyChain      []obj  `json:"key_chain"`
	}
	resp := anon(e, http.MethodGet, "/public/links/"+live.ID+"/nodes/"+file.ID+"/version", doc.Token)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &v)
	if v.BlobID != old.BlobID || v.KeyGeneration != 1 || len(v.KeyChain) != 1 {
		t.Errorf("version under a rotated link %s", resp.body)
	}
	anon(e, http.MethodGet, "/public/links/"+live.ID+"/blobs/"+old.BlobID, doc.Token).wantStatus(t, http.StatusOK)
}

func TestLinkGoesWithItsNodeAndOwner(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	tr := newLinkTree(t, e, alice)
	admin := e.login("root")
	resp := admin.call(http.MethodDelete, api+"/admin/users/"+alice.id, obj{"current_auth_key": b64(key("root"))})
	resp.wantStatus(t, http.StatusNoContent)
	e.call(http.MethodGet, api+"/public/links/"+tr.link.ID, nil).wantError(t, http.StatusNotFound, "not_found")
	anon(e, http.MethodGet, "/public/links/"+tr.link.ID+"/nodes/"+tr.folder.ID, tr.token).wantError(t, http.StatusNotFound, "not_found")
}
