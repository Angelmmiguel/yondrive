package server_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/store"
)

type editingBody struct {
	Editors []struct {
		UserID   string    `json:"user_id"`
		Username string    `json:"username"`
		Since    time.Time `json:"since"`
	} `json:"editors"`
	TTL int `json:"ttl_seconds"`
}

func (d *driveUser) editing(method, node string) editingBody {
	d.e.t.Helper()
	resp := d.call(method, api+"/nodes/"+node+"/editing", nil)
	resp.wantStatus(d.e.t, http.StatusOK)
	var out editingBody
	resp.decode(d.e.t, &out)
	return out
}

func names(b editingBody) []string {
	out := []string{}
	for _, e := range b.Editors {
		out = append(out, e.Username)
	}
	return out
}

func TestEditingInASharedFolder(t *testing.T) {
	eachMode(t, func(t *testing.T, mode string) {
		e, alice, bob := driveEnv(t, mode)
		_, folder, g := sharedFolder(t, alice, bob, "editor")
		file := alice.create(folder.ID, "file", "doc")

		// Nobody else yet: the caller is never on its own list.
		got := alice.editing(http.MethodPut, file.ID)
		if len(got.Editors) != 0 || got.TTL <= 0 {
			t.Fatalf("alice alone = %+v", got)
		}
		got = bob.editing(http.MethodPut, file.ID)
		if n := names(got); len(n) != 1 || n[0] != "alice" || got.Editors[0].UserID != alice.id {
			t.Fatalf("bob sees %v", n)
		}
		if n := names(alice.editing(http.MethodGet, file.ID)); len(n) != 1 || n[0] != "bob" {
			t.Fatalf("alice sees %v", n)
		}
		since := got.Editors[0].Since

		// A heartbeat within the time to live keeps the run going.
		e.advance(30 * time.Second)
		alice.editing(http.MethodPut, file.ID)
		e.advance(30 * time.Second)
		got = bob.editing(http.MethodGet, file.ID)
		if n := names(got); len(n) != 1 || !got.Editors[0].Since.Equal(since) {
			t.Fatalf("after a heartbeat bob sees %+v", got)
		}

		// Without one, it lapses, and the next starts a new run.
		e.advance(time.Duration(got.TTL+1) * time.Second)
		if n := names(bob.editing(http.MethodGet, file.ID)); len(n) != 0 {
			t.Fatalf("lapsed, bob still sees %v", n)
		}
		alice.editing(http.MethodPut, file.ID)
		got = bob.editing(http.MethodGet, file.ID)
		if len(got.Editors) != 1 || !got.Editors[0].Since.After(since) {
			t.Fatalf("a new run = %+v", got)
		}

		// Someone whose grant became read-only is not editing any more, and cannot say so.
		bob.editing(http.MethodPut, file.ID)
		alice.call(http.MethodPatch, api+"/grants/"+g.ID, obj{"role": "viewer", "signature": alice.signature()}).wantStatus(t, http.StatusOK)
		if n := names(alice.editing(http.MethodGet, file.ID)); len(n) != 0 {
			t.Fatalf("a viewer is listed: %v", n)
		}
		bob.call(http.MethodPut, api+"/nodes/"+file.ID+"/editing", nil).wantError(t, http.StatusForbidden, "forbidden")
		if n := names(bob.editing(http.MethodGet, file.ID)); len(n) != 1 || n[0] != "alice" {
			t.Fatalf("a viewer still sees who edits: %v", n)
		}

		// Once the grant is gone the node is not there for them at all.
		alice.call(http.MethodDelete, api+"/grants/"+g.ID, nil).wantStatus(t, http.StatusNoContent)
		bob.call(http.MethodGet, api+"/nodes/"+file.ID+"/editing", nil).wantError(t, http.StatusNotFound, "not_found")
		bob.call(http.MethodPut, api+"/nodes/"+file.ID+"/editing", nil).wantError(t, http.StatusNotFound, "not_found")
	})
}

func TestEditingIsNotForStrangers(t *testing.T) {
	_, alice, bob := driveEnv(t, "e2e")
	file := alice.create(alice.root().ID, "file", "doc")
	alice.editing(http.MethodPut, file.ID)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		bob.call(method, api+"/nodes/"+file.ID+"/editing", nil).wantError(t, http.StatusNotFound, "not_found")
		bob.call(method, api+"/nodes/"+store.NewID()+"/editing", nil).wantError(t, http.StatusNotFound, "not_found")
		bob.call(method, api+"/nodes/not-an-id/editing", nil).wantError(t, http.StatusBadRequest, "invalid_id")
	}
}

func TestSweepDropsLapsedEditing(t *testing.T) {
	e, alice, _ := driveEnv(t, "none")
	file := alice.create(alice.root().ID, "file", "doc")
	alice.editing(http.MethodPut, file.ID)
	e.advance(time.Hour)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	// Asked as of long ago, whatever row is left would count.
	left, err := e.st.Editors(ctx, file.ID, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(left) != 0 {
		t.Errorf("heartbeats left: %+v", left)
	}
}
