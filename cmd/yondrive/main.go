// Command yondrive serves the YonDrive API and web app from a single binary
// and a single data directory.
package main

import (
	"context"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/oidc"
	"github.com/Angelmmiguel/yondrive/internal/server"
	"github.com/Angelmmiguel/yondrive/internal/store"
	"github.com/Angelmmiguel/yondrive/web"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const (
	shutdownTimeout      = 10 * time.Second
	sessionPurgeInterval = time.Minute
	sweepInterval        = time.Hour
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var run func([]string) error
	switch os.Args[1] {
	case "serve":
		run = serve
	case "admin":
		run = admin
	case "backup":
		run = backup
	case "restore":
		run = restore
	case "migrate":
		run = migrate
	case "assets":
		run = assets
	case "version", "--version":
		printVersion(os.Stdout)
		return
	default:
		usage()
		os.Exit(2)
	}
	if err := run(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "yondrive:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `yondrive serves a zero-knowledge encrypted drive.

usage:
  yondrive serve [flags]
  yondrive backup [--data dir] <dest>
                     take a consistent snapshot into an empty directory, beside
                     a running server
  yondrive restore [--data dir] <backup>
                     copy a backup into a new, empty data directory
  yondrive migrate [--data dir] [--check]
                     apply the schema migrations with the server stopped, or
                     with --check only report them; serve also applies them
  yondrive admin reset-totp [--data dir] <username>
                     turn off a user's TOTP, with the server stopped
  yondrive admin promote [--data dir] <username>
                     make a user an enabled admin, with the server stopped
  yondrive admin password-reset [--data dir] <username>
                     print a one-time reset link, in mode none only, with the
                     server stopped
  yondrive version   print the version, the commit and the web app's hash
  yondrive assets    print the SHA-256 of every file of the embedded web app
  yondrive assets check [--manifest file] <url>
                     compare what a server serves with this binary's list, or
                     with a published one

serve flags:
  --addr             listen address (env YONDRIVE_ADDR, default 127.0.0.1:8080);
                     use :8080 to listen on every interface
  --data             data directory (env YONDRIVE_DATA, default ./data)
  --public-url       address used in share links and for OIDC
                     (env YONDRIVE_PUBLIC_URL)
  --secure           auto, true or false (env YONDRIVE_SECURE, default auto):
                     whether requests count as HTTPS. auto follows the
                     X-Forwarded-Proto of a trusted proxy. The server itself
                     speaks plain HTTP; TLS is the reverse proxy's job.
  --trusted-proxies  comma-separated addresses or CIDR ranges of the reverse
                     proxy, whose forwarded headers are then believed
                     (env YONDRIVE_TRUSTED_PROXIES)
  --ca-file          PEM file of certificate authorities to trust as well as the
                     system's, for an identity provider behind an internal one
                     (env YONDRIVE_CA_FILE)
`)
}

// settings is the startup configuration, from flags and the environment.
type settings struct {
	addr      string
	dataDir   string
	publicURL string
	secure    server.SecureMode
	proxies   []netip.Prefix
	roots     *x509.CertPool
}

func parseSettings(args []string) (settings, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.Usage = usage
	addr := fs.String("addr", env("YONDRIVE_ADDR", "127.0.0.1:8080"), "listen address")
	dataDir := fs.String("data", env("YONDRIVE_DATA", "./data"), "data directory")
	publicURL := fs.String("public-url", os.Getenv("YONDRIVE_PUBLIC_URL"), "public address")
	secure := fs.String("secure", env("YONDRIVE_SECURE", "auto"), "auto, true or false")
	proxies := fs.String("trusted-proxies", os.Getenv("YONDRIVE_TRUSTED_PROXIES"), "reverse proxy addresses or CIDR ranges")
	caFile := fs.String("ca-file", os.Getenv("YONDRIVE_CA_FILE"), "PEM file of extra certificate authorities")
	if err := fs.Parse(args); err != nil {
		return settings{}, err
	}
	var s settings
	var err error
	s.addr, s.dataDir = *addr, *dataDir
	if s.publicURL, err = parsePublicURL(*publicURL); err != nil {
		return settings{}, fmt.Errorf("--public-url: %w", err)
	}
	if s.secure, err = parseSecure(*secure); err != nil {
		return settings{}, fmt.Errorf("--secure: %w", err)
	}
	if s.proxies, err = parsePrefixes(*proxies); err != nil {
		return settings{}, fmt.Errorf("--trusted-proxies: %w", err)
	}
	// A file that does not load stops the server: sign-in failing later, for a reason
	// far from here, is harder to find.
	if s.roots, err = oidc.LoadRoots(*caFile); err != nil {
		return settings{}, fmt.Errorf("--ca-file: %w", err)
	}
	return s, nil
}

func serve(args []string) error {
	cfg, err := parseSettings(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	st, err := store.Open(cfg.dataDir)
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()

	var setupToken string
	if _, err := st.Settings(context.Background()); errors.Is(err, store.ErrNotConfigured) {
		setupToken = auth.NewToken()
		log.Info("first-run setup required, open this link", "link", setupLink(cfg.publicURL, cfg.addr, setupToken))
	} else if err != nil {
		return err
	}

	srv, err := server.New(server.Config{
		Version:        version,
		Commit:         commit,
		WebBundle:      web.EmbeddedBundle().Root,
		Secure:         cfg.secure,
		TrustedProxies: cfg.proxies,
		OIDCRoots:      cfg.roots,
		DataDir:        cfg.dataDir,
		PublicURL:      cfg.publicURL,
		SetupToken:     setupToken,
		UI:             web.Handler(),
		Logger:         log,
	}, st)
	if err != nil {
		return err
	}

	httpSrv := &http.Server{
		Addr:    cfg.addr,
		Handler: srv,
		// Bound the time a connection may hold the server hostage before it
		// has sent a complete request head; the handlers bound the body. There
		// is deliberately no WriteTimeout: downloads are large and slow links
		// are normal.
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.PurgeExpiredSessions(ctx, sessionPurgeInterval)
	go srv.RunSweeper(ctx, sweepInterval)

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.addr, "data", cfg.dataDir, "version", version, "commit", commit, "web", web.EmbeddedBundle().Root)
		errc <- httpSrv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("listen: %w", err)
		}
		return nil
	case <-ctx.Done():
		log.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown: %w", err)
		}
		return nil
	}
}

// parseSecure accepts auto, true and false. Anything else is an error, so a
// typo cannot silently turn a protection off.
func parseSecure(v string) (server.SecureMode, error) {
	switch m := server.SecureMode(strings.ToLower(strings.TrimSpace(v))); m {
	case server.SecureAuto, server.SecureAlways, server.SecureNever:
		return m, nil
	case "":
		return server.SecureAuto, nil
	}
	return "", fmt.Errorf("%q is not auto, true or false", v)
}

// parsePublicURL accepts an empty value, or an address the server accepts.
func parsePublicURL(v string) (string, error) {
	if strings.TrimSpace(v) == "" {
		return "", nil
	}
	return server.ParsePublicURL(v)
}

// setupLink is the address printed for the first run. The token goes in the
// fragment, so it stays out of proxy logs and the Referer header.
func setupLink(publicURL, addr, token string) string {
	base := publicURL
	if base == "" {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			base = "http://" + addr
		} else {
			if host == "" {
				host = "localhost"
			}
			base = "http://" + net.JoinHostPort(host, port)
		}
	}
	return base + "/setup#" + token
}

// parsePrefixes reads a comma-separated list of addresses and CIDR ranges;
// a bare address stands for itself alone.
func parsePrefixes(list string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if p, err := netip.ParsePrefix(item); err == nil {
			prefixes = append(prefixes, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(item)
		if err != nil {
			return nil, fmt.Errorf("%q is neither an address nor a CIDR range", item)
		}
		prefixes = append(prefixes, netip.PrefixFrom(a, a.BitLen()))
	}
	return prefixes, nil
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
