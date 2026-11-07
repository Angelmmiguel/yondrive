package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	return checkAssets(context.Background(), assetClient(), fs.Arg(0), manifest, os.Stdout)
}

// assetClient makes the requests of `yondrive assets check`. It follows no
// redirect: a file must come from the address the operator named, not from
// wherever that address points.
func assetClient() *http.Client {
	return &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// shellPaths are routes the app shell is served at besides /, as the server
// answers every path that is not a file with it. A server could serve another
// shell at some of them, so a few are checked.
var shellPaths = []string{"signin", "s/x"}

// checkAssets fetches every file a manifest lists from the server at base and
// compares its hash, the shell at a few of its routes as well, and the root the
// server claims with the list's. It reports each difference and fails if there
// is any.
func checkAssets(ctx context.Context, client *http.Client, base string, manifest []byte, out io.Writer) error {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("assets check: %q is not an http or https address", base)
	}
	entries, err := parseManifest(manifest)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(manifest)
	root := hex.EncodeToString(sum[:])
	_, _ = fmt.Fprintf(out, "checking %d files against the list with root %s\n", len(entries), root)
	bad, checked := 0, 0
	check := func(path, want string) {
		checked++
		got, err := fetchHash(ctx, client, u, path)
		switch {
		case err != nil:
			bad++
			_, _ = fmt.Fprintf(out, "FAILED  %s: %v\n", path, err)
		case got != want:
			bad++
			_, _ = fmt.Fprintf(out, "DIFFERS %s\n", path)
		}
	}
	for _, e := range entries {
		check(e.path, e.sum)
		if e.path == "index.html" {
			for _, p := range shellPaths {
				check(p, e.sum)
			}
		}
	}
	claimed, err := claimedRoot(ctx, client, u)
	switch {
	case err != nil:
		bad++
		_, _ = fmt.Fprintf(out, "FAILED  the server's root: %v\n", err)
	case claimed != root:
		bad++
		_, _ = fmt.Fprintf(out, "DIFFERS the server claims root %s\n", claimed)
	default:
		_, _ = fmt.Fprintf(out, "the server claims root %s\n", claimed)
	}
	if bad > 0 {
		return fmt.Errorf("assets check: %d of %d checks differ from the list", bad, checked+1)
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

// fetchHash returns the SHA-256 of what the server serves at path.
func fetchHash(ctx context.Context, client *http.Client, base *url.URL, path string) (string, error) {
	// The server answers /index.html with a redirect to /, as Go's file server
	// does, and serves the same file there.
	if path == "index.html" {
		path = ""
	}
	h := sha256.New()
	if err := fetch(ctx, client, base, path, func(r io.Reader) error {
		_, err := io.Copy(h, r)
		return err
	}); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// claimedRoot returns the root hash the server reports in its health route.
func claimedRoot(ctx context.Context, client *http.Client, base *url.URL) (string, error) {
	var health struct {
		WebBundle string `json:"web_bundle"`
	}
	if err := fetch(ctx, client, base, "api/v1/health", func(r io.Reader) error {
		return json.NewDecoder(io.LimitReader(r, 1<<16)).Decode(&health)
	}); err != nil {
		return "", err
	}
	if health.WebBundle == "" {
		return "", errors.New("the server reports no web app")
	}
	return health.WebBundle, nil
}

// fetch gets path under base and hands a 200's body to read.
func fetch(ctx context.Context, client *http.Client, base *url.URL, path string, read func(io.Reader) error) error {
	ctx, cancel := context.WithTimeout(ctx, assetTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base.JoinPath(path).String(), nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return fmt.Errorf("status %d, a redirect to %q, not followed", resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return read(resp.Body)
}
