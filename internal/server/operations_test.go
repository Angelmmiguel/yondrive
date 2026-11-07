package server_test

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/server"
)

func auditPage(t *testing.T, c *client, query string) (ids []int64, actions []string, next string) {
	t.Helper()
	resp := c.call(http.MethodGet, "/api/v1/admin/audit"+query, nil)
	resp.wantStatus(t, http.StatusOK)
	var page struct {
		Entries []struct {
			ID     int64  `json:"id"`
			Action string `json:"action"`
			Actor  string `json:"actor_id"`
		} `json:"entries"`
		Next string `json:"next_cursor"`
	}
	resp.decode(t, &page)
	for _, e := range page.Entries {
		ids = append(ids, e.ID)
		actions = append(actions, e.Action)
	}
	return ids, actions, page.Next
}

func TestAuditIsPagedNewestFirstAndAdminOnly(t *testing.T) {
	e := configured(t, "e2e", server.Config{})
	root := e.login("root")
	for range 4 {
		e.login("root")
	}
	first, actions, next := auditPage(t, root, "?limit=3")
	if len(first) != 3 || next == "" || actions[0] != "login_succeeded" {
		t.Fatalf("page = %v %v, next %q", first, actions, next)
	}
	second, _, _ := auditPage(t, root, "?limit=100&cursor="+next)
	if len(second) == 0 || second[0] >= first[2] {
		t.Errorf("pages overlap: %v then %v", first, second)
	}
	all, _, last := auditPage(t, root, "?limit=1000")
	if last != "" || len(all) != len(first)+len(second) {
		t.Errorf("all = %v, next %q", all, last)
	}
	root.call(http.MethodGet, "/api/v1/admin/audit?cursor=x", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")

	e.register(root, "alice", "e2e")
	e.login("alice").call(http.MethodGet, "/api/v1/admin/audit", nil).wantError(t, http.StatusForbidden, "forbidden")
	e.call(http.MethodGet, "/api/v1/admin/audit", nil).wantError(t, http.StatusUnauthorized, "unauthorized")
}

func TestAuditRetention(t *testing.T) {
	e := configured(t, "e2e", server.Config{SessionTTL: 3650 * day, SessionMaxAge: 3650 * day})
	root := e.login("root")
	resp := root.call(http.MethodPatch, "/api/v1/admin/settings", obj{"audit_retention_days": 3650})
	resp.wantStatus(t, http.StatusOK)

	// Shortening it would erase the tracks of a stolen session.
	root.call(http.MethodPatch, "/api/v1/admin/settings", obj{"audit_retention_days": 10}).wantError(t, http.StatusUnauthorized, "wrong_credential")
	root.call(http.MethodPatch, "/api/v1/admin/settings", obj{"audit_retention_days": 10, "current_auth_key": b64(key("root"))}).wantStatus(t, http.StatusOK)
	root.call(http.MethodPatch, "/api/v1/admin/settings", obj{"audit_retention_days": 4000}).wantError(t, http.StatusBadRequest, "invalid_settings")
	// Keeping it for good needs nothing, and leaving that does.
	root.call(http.MethodPatch, "/api/v1/admin/settings", obj{"audit_retention_days": 0}).wantStatus(t, http.StatusOK)
	root.call(http.MethodPatch, "/api/v1/admin/settings", obj{"audit_retention_days": 3650}).wantError(t, http.StatusUnauthorized, "wrong_credential")

	before, _, _ := auditPage(t, root, "?limit=1000")
	e.advance(1000 * 24 * time.Hour)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if after, _, _ := auditPage(t, root, "?limit=1000"); len(after) != len(before) {
		t.Errorf("kept for good, %d became %d", len(before), len(after))
	}
	root.call(http.MethodPatch, "/api/v1/admin/settings", obj{"audit_retention_days": 10, "current_auth_key": b64(key("root"))}).wantStatus(t, http.StatusOK)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	// Only what the sweep could call old is gone, so a recent event stays.
	root = e.login("root")
	after, actions, _ := auditPage(t, root, "?limit=1000")
	if len(after) >= len(before) || len(after) == 0 || actions[0] != "login_succeeded" {
		t.Errorf("%d entries became %v", len(before), actions)
	}
	var health struct {
		Audit   *int64 `json:"audit_entries"`
		Journal *int64 `json:"journal_entries"`
	}
	resp = root.call(http.MethodGet, "/api/v1/admin/health", nil)
	resp.wantStatus(t, http.StatusOK)
	resp.decode(t, &health)
	if health.Audit == nil || *health.Audit != int64(len(after)) || health.Journal == nil {
		t.Errorf("health = %s", resp.body)
	}
}

// changesPage reads the journal from a cursor, and fails the test on any error.
func changesPage(t *testing.T, d *driveUser, query string) (count int, next string) {
	t.Helper()
	resp := d.call(http.MethodGet, api+"/changes"+query, nil)
	resp.wantStatus(t, http.StatusOK)
	var page struct {
		Changes []struct {
			Seq int64 `json:"seq"`
		} `json:"changes"`
		Next string `json:"next_cursor"`
	}
	resp.decode(t, &page)
	return len(page.Changes), page.Next
}

func TestJournalTrimExpiresOldCursors(t *testing.T) {
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) {
			e, alice, bob := driveEnv(t, mode)
			root := alice.root()
			alice.create(root.ID, "file", "one")
			_, quiet := changesPage(t, bob, "")
			stale := "0"

			e.advance(100 * 24 * time.Hour)
			alice.create(root.ID, "file", "two")
			if err := e.srv.Sweep(ctx); err != nil {
				t.Fatal(err)
			}

			alice.call(http.MethodGet, api+"/changes?cursor="+stale, nil).wantError(t, http.StatusGone, "cursor_expired")

			// Someone else's journal being trimmed costs a quiet user nothing.
			if n, _ := changesPage(t, bob, "?cursor="+quiet); n != 0 {
				t.Errorf("bob sees %d changes", n)
			}

			// Starting over works, and shows what is left, and the new cursor holds.
			n, next := changesPage(t, alice, "")
			if n != 1 {
				t.Errorf("%d changes left, want 1", n)
			}
			if n, _ := changesPage(t, alice, "?cursor="+next); n != 0 {
				t.Errorf("%d changes after the end", n)
			}
		})
	}
}

func TestEmptyJournalPageMovesPastTheFloor(t *testing.T) {
	e, alice, _ := driveEnv(t, "e2e")
	alice.create(alice.root().ID, "file", "one")
	e.advance(100 * 24 * time.Hour)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	n, next := changesPage(t, alice, "")
	if n != 0 {
		t.Fatalf("%d changes", n)
	}
	if v, err := strconv.ParseInt(next, 10, 64); err != nil || v == 0 {
		t.Errorf("next = %q", next)
	}
	if n, _ := changesPage(t, alice, "?cursor="+next); n != 0 {
		t.Errorf("%d changes", n)
	}
}

func TestJournalKeptForGoodIsNotTrimmed(t *testing.T) {
	e, alice, _ := driveEnv(t, "e2e")
	alice.create(alice.root().ID, "file", "one")
	e.login("root").call(http.MethodPatch, "/api/v1/admin/settings", obj{"journal_retention_days": 0}).wantStatus(t, http.StatusOK)
	e.advance(1000 * 24 * time.Hour)
	if err := e.srv.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if n, _ := changesPage(t, alice, "?cursor=0"); n == 0 {
		t.Error("the journal was trimmed")
	}
}

func TestListUploads(t *testing.T) {
	for _, mode := range []string{"e2e", "none"} {
		t.Run(mode, func(t *testing.T) {
			e, alice, bob := driveEnv(t, mode)
			file := alice.create(alice.root().ID, "file", "one")
			frames := alice.frames(1, 1)
			var ids []string
			for range 3 {
				ids = append(ids, alice.startUpload(file.ID, frames).ID)
			}
			alice.put(ids[0], 0, frames[0]).wantStatus(t, http.StatusNoContent)

			type summary struct {
				ID       string `json:"id"`
				Node     string `json:"node_id"`
				Received int64  `json:"frames_received"`
				Frames   any    `json:"frames"`
			}
			read := func(d *driveUser, query string) (out []summary, next string) {
				t.Helper()
				resp := d.call(http.MethodGet, api+"/uploads"+query, nil)
				resp.wantStatus(t, http.StatusOK)
				var page struct {
					Uploads []summary `json:"uploads"`
					Next    string    `json:"next_cursor"`
				}
				resp.decode(t, &page)
				return page.Uploads, page.Next
			}
			first, next := read(alice, "?limit=2")
			if len(first) != 2 || next == "" {
				t.Fatalf("first page = %v, next %q", first, next)
			}
			rest, last := read(alice, "?limit=2&cursor="+next)
			if len(rest) != 1 || last != "" {
				t.Fatalf("second page = %v, next %q", rest, last)
			}
			got := map[string]summary{}
			for _, u := range append(first, rest...) {
				got[u.ID] = u
			}
			if got[ids[0]].Received != 1 || got[ids[1]].Received != 0 || got[ids[0]].Node != file.ID {
				t.Errorf("uploads = %+v", got)
			}
			if got[ids[0]].Frames != nil {
				t.Error("a list holds every frame index")
			}
			if theirs, _ := read(bob, ""); len(theirs) != 0 {
				t.Errorf("bob sees %v", theirs)
			}

			// A lost id is found here, and let go of.
			alice.call(http.MethodDelete, api+"/uploads/"+ids[1], nil).wantStatus(t, http.StatusNoContent)
			if left, _ := read(alice, ""); len(left) != 2 {
				t.Errorf("after the abort: %v", left)
			}
			alice.call(http.MethodGet, api+"/uploads?cursor=nope", nil).wantError(t, http.StatusBadRequest, "invalid_cursor")
			alice.call(http.MethodGet, api+"/uploads?limit=0", nil).wantError(t, http.StatusBadRequest, "bad_request")
			e.call(http.MethodGet, api+"/uploads", nil).wantError(t, http.StatusUnauthorized, "unauthorized")
		})
	}
}
