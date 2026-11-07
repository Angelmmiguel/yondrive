package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/Angelmmiguel/yondrive/web"
)

// commit is set at build time with -ldflags "-X main.commit=...".
var commit = "unknown"

// assetTimeout bounds each request `yondrive assets check` makes.
const assetTimeout = 30 * time.Second

// printVersion writes what identifies this build: the release, the commit, the
// Go release and the root hash of the web app it serves.
func printVersion(w io.Writer) {
	_, _ = fmt.Fprintf(w, "yondrive %s\ncommit   %s\ngo       %s\nweb      %s\n",
		version, commit, runtime.Version(), web.EmbeddedBundle().Root)
}

// assets prints the hashes of the embedded web app, or checks a running
// server's against them or against a published list.
func assets(args []string) error {
	if len(args) == 0 {
		_, err := os.Stdout.Write(web.EmbeddedBundle().Manifest)
		return err
	}
	if args[0] != "check" {
		usage()
		return errors.New("assets: unknown command")
	}
	fs := flag.NewFlagSet("assets check", flag.ContinueOnError)
	fs.Usage = usage
	from := fs.String("manifest", "", "published list of hashes to check against, instead of this binary's")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 1 {
		usage()
		return errors.New("assets check: name the server's address")
	}
	manifest := web.EmbeddedBundle().Manifest
	if *from != "" {
		var err error
		if manifest, err = os.ReadFile(*from); err != nil {
			return fmt.Errorf("assets check: %w", err)
		}
	}
	return checkAssets(context.Background(), http.DefaultClient, fs.Arg(0), manifest, os.Stdout)
}

// checkAssets fetches every file a manifest lists from the server at base and
// compares its hash. It reports each difference and fails if there is any.
func checkAssets(ctx context.Context, client *http.Client, base string, manifest []byte, out io.Writer) error {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("assets check: %q is not an http or https address", base)
	}
	entries, err := parseManifest(manifest)
	if err != nil {
		return err
	}
	root := sha256.Sum256(manifest)
	_, _ = fmt.Fprintf(out, "checking %d files against the list with root %s\n", len(entries), hex.EncodeToString(root[:]))
	bad := 0
	for _, e := range entries {
		got, err := fetchHash(ctx, client, u, e.path)
		switch {
		case err != nil:
			bad++
			_, _ = fmt.Fprintf(out, "FAILED  %s: %v\n", e.path, err)
		case got != e.sum:
			bad++
			_, _ = fmt.Fprintf(out, "DIFFERS %s\n", e.path)
		}
	}
	if bad > 0 {
		return fmt.Errorf("assets check: %d of %d files differ from the list", bad, len(entries))
	}
	_, err = fmt.Fprintln(out, "every file matches")
	return err
}

type manifestEntry struct{ sum, path string }

// parseManifest reads the sha256sum format that `yondrive assets` writes.
func parseManifest(data []byte) ([]manifestEntry, error) {
	var entries []manifestEntry
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		sum, path, ok := strings.Cut(line, "  ")
		if _, err := hex.DecodeString(sum); !ok || err != nil || len(sum) != 64 || path == "" || strings.Contains(path, "..") {
			return nil, fmt.Errorf("assets check: malformed line %q", line)
		}
		entries = append(entries, manifestEntry{sum: sum, path: path})
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("assets check: %w", err)
	}
	if len(entries) == 0 {
		return nil, errors.New("assets check: the list is empty")
	}
	return entries, nil
}

func fetchHash(ctx context.Context, client *http.Client, base *url.URL, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, assetTimeout)
	defer cancel()
	// The server answers /index.html with a redirect to /, as Go's file server
	// does, and serves the same file there.
	if path == "index.html" {
		path = ""
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.JoinPath(path).String(), nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	h := sha256.New()
	if _, err := io.Copy(h, resp.Body); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
