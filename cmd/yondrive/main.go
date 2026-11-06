// Command yondrive serves the YonDrive API and web app from a single binary
// and a single data directory.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/Angelmmiguel/yondrive/internal/server"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const shutdownTimeout = 10 * time.Second

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		usage()
		os.Exit(2)
	}
	if err := serve(os.Args[2:]); err != nil {
		fmt.Fprintln(os.Stderr, "yondrive:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `yondrive serves a zero-knowledge encrypted drive.

usage:
  yondrive serve [flags]

flags:
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
`)
}

// settings is the startup configuration, from flags and the environment.
type settings struct {
	addr      string
	dataDir   string
	publicURL string
	secure    server.SecureMode
	proxies   []netip.Prefix
}

func parseSettings(args []string) (settings, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.Usage = usage
	addr := fs.String("addr", env("YONDRIVE_ADDR", "127.0.0.1:8080"), "listen address")
	dataDir := fs.String("data", env("YONDRIVE_DATA", "./data"), "data directory")
	publicURL := fs.String("public-url", os.Getenv("YONDRIVE_PUBLIC_URL"), "public address")
	secure := fs.String("secure", env("YONDRIVE_SECURE", "auto"), "auto, true or false")
	proxies := fs.String("trusted-proxies", os.Getenv("YONDRIVE_TRUSTED_PROXIES"), "reverse proxy addresses or CIDR ranges")
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

	if err := os.MkdirAll(cfg.dataDir, 0o700); err != nil {
		return fmt.Errorf("data directory: %w", err)
	}

	srv := server.New(server.Config{
		Version:        version,
		Secure:         cfg.secure,
		TrustedProxies: cfg.proxies,
		Logger:         log,
	})

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

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", cfg.addr, "data", cfg.dataDir, "version", version)
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

// parsePublicURL accepts an empty value, or an http or https address with a
// host and no query, fragment or credentials.
func parsePublicURL(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "", nil
	}
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("%q is not an http or https address", v)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%q must not carry credentials, a query or a fragment", v)
	}
	return strings.TrimRight(u.String(), "/"), nil
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
