package web

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
	"testing/fstest"
)

func hexSum(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func TestBundleListsEveryFileInByteOrder(t *testing.T) {
	b, err := bundleOf(fstest.MapFS{
		"index.html": {Data: []byte("shell")},
		"a/b.js":     {Data: []byte("b")},
		"a.txt":      {Data: []byte("t")},
		".gitkeep":   {},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := hexSum("") + "  .gitkeep\n" +
		hexSum("t") + "  a.txt\n" +
		hexSum("b") + "  a/b.js\n" +
		hexSum("shell") + "  index.html\n"
	if string(b.Manifest) != want {
		t.Errorf("manifest =\n%s\nwant\n%s", b.Manifest, want)
	}
	if b.Root != hexSum(want) {
		t.Errorf("root = %s, want the hash of the manifest", b.Root)
	}
}

func TestBundleChangesWithAnyFile(t *testing.T) {
	one, _ := bundleOf(fstest.MapFS{"x.js": {Data: []byte("1")}})
	two, _ := bundleOf(fstest.MapFS{"x.js": {Data: []byte("2")}})
	renamed, _ := bundleOf(fstest.MapFS{"y.js": {Data: []byte("1")}})
	if one.Root == two.Root || one.Root == renamed.Root {
		t.Error("the root hash did not follow a change")
	}
}

func TestEmbeddedBundleCoversWhatIsServed(t *testing.T) {
	b := EmbeddedBundle()
	if len(b.Root) != 64 {
		t.Fatalf("root = %q", b.Root)
	}
	// A clean checkout embeds the placeholder alone; a build embeds the app.
	if !strings.Contains(string(b.Manifest), "  .gitkeep\n") {
		t.Errorf("manifest misses the placeholder:\n%s", b.Manifest)
	}
}
