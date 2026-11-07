package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Angelmmiguel/yondrive/web"
)

func TestPrintVersion(t *testing.T) {
	var out bytes.Buffer
	printVersion(&out)
	for _, want := range []string{"yondrive " + version, "commit   " + commit, "web      " + web.EmbeddedBundle().Root} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("version output %q lacks %q", out.String(), want)
		}
	}
}

func listOf(files map[string]string) []byte {
	var b bytes.Buffer
	for _, name := range []string{"_app/x.js", "index.html"} {
		if body, ok := files[name]; ok {
			sum := sha256.Sum256([]byte(body))
			fmt.Fprintf(&b, "%s  %s\n", hex.EncodeToString(sum[:]), name)
		}
	}
	return b.Bytes()
}

func TestCheckAssets(t *testing.T) {
	list := listOf(map[string]string{"index.html": "shell", "_app/x.js": "code"})
	listRoot := sha256.Sum256(list)
	// Like the real server: files where they are, the shell at every other path,
	// and the health route's claim.
	served := map[string]string{"/_app/x.js": "code"}
	shellAt := map[string]string{}
	claim := hex.EncodeToString(listRoot[:])
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("code")) }))
	defer elsewhere.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/health":
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "web_bundle": claim})
		case r.URL.Path == "/redirected.js":
			http.Redirect(w, r, elsewhere.URL+"/x.js", http.StatusFound)
		case strings.HasPrefix(r.URL.Path, "/_app/"):
			body, ok := served[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(body))
		default:
			body, ok := shellAt[r.URL.Path]
			if !ok {
				body = "shell"
			}
			_, _ = w.Write([]byte(body))
		}
	}))
	defer srv.Close()
	ctx := context.Background()

	var out bytes.Buffer
	if err := checkAssets(ctx, assetClient(), srv.URL, list, &out); err != nil {
		t.Fatalf("matching server: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "every file matches") || !strings.Contains(out.String(), "claims root "+claim) {
		t.Errorf("output = %q", out.String())
	}

	// A file served with other bytes, and one not served at all.
	out.Reset()
	served["/_app/x.js"] = "tampered"
	if err := checkAssets(ctx, assetClient(), srv.URL, list, &out); err == nil || !strings.Contains(out.String(), "DIFFERS _app/x.js") {
		t.Errorf("tampered file: %v\n%s", err, out.String())
	}
	out.Reset()
	delete(served, "/_app/x.js")
	if err := checkAssets(ctx, assetClient(), srv.URL, list, &out); err == nil || !strings.Contains(out.String(), "FAILED  _app/x.js: status 404") {
		t.Errorf("missing file: %v\n%s", err, out.String())
	}
	served["/_app/x.js"] = "code"

	// Another shell at a route that is not /.
	out.Reset()
	shellAt["/s/x"] = "another shell"
	if err := checkAssets(ctx, assetClient(), srv.URL, list, &out); err == nil || !strings.Contains(out.String(), "DIFFERS s/x") {
		t.Errorf("shell at a link route: %v\n%s", err, out.String())
	}
	delete(shellAt, "/s/x")

	// A server that claims another app.
	out.Reset()
	claim = strings.Repeat("0", 64)
	if err := checkAssets(ctx, assetClient(), srv.URL, list, &out); err == nil || !strings.Contains(out.String(), "DIFFERS the server claims root "+claim) {
		t.Errorf("claimed root: %v\n%s", err, out.String())
	}
	claim = hex.EncodeToString(listRoot[:])

	// A file that redirects elsewhere is not followed, even to the right bytes.
	out.Reset()
	sum := sha256.Sum256([]byte("code"))
	redirected := append(append([]byte{}, list...), fmt.Sprintf("%s  redirected.js\n", hex.EncodeToString(sum[:]))...)
	if err := checkAssets(ctx, assetClient(), srv.URL, redirected, &out); err == nil || !strings.Contains(out.String(), "FAILED  redirected.js: status 302") {
		t.Errorf("redirect: %v\n%s", err, out.String())
	}

	for _, bad := range [][]byte{nil, []byte("nothex  index.html\n"), []byte(strings.Repeat("a", 64) + "  ../etc/passwd\n")} {
		if err := checkAssets(ctx, assetClient(), srv.URL, bad, &out); err == nil {
			t.Errorf("accepted the list %q", bad)
		}
	}
	if err := checkAssets(ctx, assetClient(), "ftp://x", list, &out); err == nil {
		t.Error("accepted an address that is not http")
	}
}

func TestCheckAssetsAgainstTheEmbeddedApp(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"web_bundle": web.EmbeddedBundle().Root})
	})
	mux.Handle("/", web.Handler())
	srv := httptest.NewServer(mux)
	defer srv.Close()
	var out bytes.Buffer
	err := checkAssets(context.Background(), assetClient(), srv.URL, web.EmbeddedBundle().Manifest, &out)
	// A checkout that has not built the app embeds only the placeholder, and the
	// handler then answers 503; a built one must match itself.
	if strings.Contains(string(web.EmbeddedBundle().Manifest), "index.html") && err != nil {
		t.Errorf("the binary's own app does not match its list: %v\n%s", err, out.String())
	}
}
