package web

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"slices"
	"sync"
)

// Bundle is the SHA-256 of every file of the embedded web app, and a root hash
// that stands for all of them.
//
// Manifest is in the format of sha256sum, one "<hex>  <path>" line per file in
// byte order of the paths, so `sha256sum -c` checks a copy of the built
// directory against it. Root is the SHA-256 of Manifest. Both are computed from
// what is embedded rather than written beside it, so they cannot disagree with
// what the binary serves.
type Bundle struct {
	Manifest []byte
	Root     string
}

// EmbeddedBundle returns the bundle of the app this binary serves. Every build
// of the same commit gives the same one (see `just verify-reproducible`).
var EmbeddedBundle = sync.OnceValue(func() Bundle {
	b, err := bundleOf(build)
	if err != nil {
		// The files are compiled in; failing to read one is a broken binary.
		panic(err)
	}
	return b
})

// bundleOf hashes every regular file under fsys.
func bundleOf(fsys fs.FS) (Bundle, error) {
	var names []string
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			names = append(names, name)
		}
		return err
	})
	if err != nil {
		return Bundle{}, fmt.Errorf("web: list the bundle: %w", err)
	}
	// Byte order, as `LC_ALL=C sort` gives, and not the walk's, which puts a
	// directory's files before a sibling such as "a.txt" that sorts first.
	slices.Sort(names)
	var manifest bytes.Buffer
	for _, name := range names {
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return Bundle{}, fmt.Errorf("web: hash the bundle: %w", err)
		}
		sum := sha256.Sum256(data)
		fmt.Fprintf(&manifest, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	}
	root := sha256.Sum256(manifest.Bytes())
	return Bundle{Manifest: manifest.Bytes(), Root: hex.EncodeToString(root[:])}, nil
}
