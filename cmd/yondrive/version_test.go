package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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
	served := map[string]string{"/": "shell", "/_app/x.js": "code"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := served[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	ctx := context.Background()

	var out bytes.Buffer
	list := listOf(map[string]string{"index.html": "shell", "_app/x.js": "code"})
	if err := checkAssets(ctx, srv.Client(), srv.URL, list, &out); err != nil {
		t.Fatalf("matching server: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "every file matches") {
		t.Errorf("output = %q", out.String())
	}

	// A file served with other bytes, and one not served at all.
	out.Reset()
	served["/_app/x.js"] = "tampered"
	if err := checkAssets(ctx, srv.Client(), srv.URL, list, &out); err == nil || !strings.Contains(out.String(), "DIFFERS _app/x.js") {
		t.Errorf("tampered file: %v\n%s", err, out.String())
	}
	out.Reset()
	delete(served, "/_app/x.js")
	if err := checkAssets(ctx, srv.Client(), srv.URL, list, &out); err == nil || !strings.Contains(out.String(), "FAILED  _app/x.js: status 404") {
		t.Errorf("missing file: %v\n%s", err, out.String())
	}

	for _, bad := range [][]byte{nil, []byte("nothex  index.html\n"), []byte(strings.Repeat("a", 64) + "  ../etc/passwd\n")} {
		if err := checkAssets(ctx, srv.Client(), srv.URL, bad, &out); err == nil {
			t.Errorf("accepted the list %q", bad)
		}
	}
	if err := checkAssets(ctx, srv.Client(), "ftp://x", list, &out); err == nil {
		t.Error("accepted an address that is not http")
	}
}

func TestCheckAssetsAgainstTheEmbeddedApp(t *testing.T) {
	srv := httptest.NewServer(web.Handler())
	defer srv.Close()
	var out bytes.Buffer
	err := checkAssets(context.Background(), srv.Client(), srv.URL, web.EmbeddedBundle().Manifest, &out)
	// A checkout that has not built the app embeds only the placeholder, and the
	// handler then answers 503; a built one must match itself.
	if strings.Contains(string(web.EmbeddedBundle().Manifest), "index.html") && err != nil {
		t.Errorf("the binary's own app does not match its list: %v\n%s", err, out.String())
	}
}
