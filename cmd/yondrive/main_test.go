package main

import (
	"testing"

	"github.com/Angelmmiguel/yondrive/internal/server"
)

func TestParseSecure(t *testing.T) {
	for in, want := range map[string]server.SecureMode{
		"":      server.SecureAuto,
		"auto":  server.SecureAuto,
		"AUTO":  server.SecureAuto,
		"true":  server.SecureAlways,
		"false": server.SecureNever,
	} {
		got, err := parseSecure(in)
		if err != nil || got != want {
			t.Errorf("parseSecure(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"yes", "1", "ture"} {
		if _, err := parseSecure(bad); err == nil {
			t.Errorf("parseSecure(%q) accepted", bad)
		}
	}
}

func TestParsePublicURL(t *testing.T) {
	for in, want := range map[string]string{
		"":                           "",
		"https://drive.example.com":  "https://drive.example.com",
		"https://drive.example.com/": "https://drive.example.com",
		"http://192.168.1.5:8990":    "http://192.168.1.5:8990",
	} {
		got, err := parsePublicURL(in)
		if err != nil || got != want {
			t.Errorf("parsePublicURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"drive.example.com", "ftp://x.example", "https://", "https://u:p@x.example", "https://x.example?a=b", "https://x.example#f"} {
		if _, err := parsePublicURL(bad); err == nil {
			t.Errorf("parsePublicURL(%q) accepted", bad)
		}
	}
}

func TestParsePrefixes(t *testing.T) {
	got, err := parsePrefixes(" 10.0.0.1, 192.168.0.0/16 ,fd00::1,,")
	if err != nil {
		t.Fatalf("parsePrefixes: %v", err)
	}
	want := []string{"10.0.0.1/32", "192.168.0.0/16", "fd00::1/128"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i].String() != want[i] {
			t.Errorf("prefix %d = %s, want %s", i, got[i], want[i])
		}
	}
	if got, err := parsePrefixes(""); err != nil || len(got) != 0 {
		t.Errorf("parsePrefixes(\"\") = %v, %v; want none", got, err)
	}
	for _, bad := range []string{"proxy", "10.0.0.0/33", "10.0.0"} {
		if _, err := parsePrefixes(bad); err == nil {
			t.Errorf("parsePrefixes(%q) accepted", bad)
		}
	}
}

func TestParseSettingsReadsTheEnvironmentAndFlagsWin(t *testing.T) {
	t.Setenv("YONDRIVE_ADDR", ":9000")
	t.Setenv("YONDRIVE_DATA", "/env/data")
	t.Setenv("YONDRIVE_SECURE", "false")
	t.Setenv("YONDRIVE_TRUSTED_PROXIES", "10.0.0.0/8")
	t.Setenv("YONDRIVE_PUBLIC_URL", "https://drive.example.com")

	s, err := parseSettings([]string{"--data", "/flag/data"})
	if err != nil {
		t.Fatalf("parseSettings: %v", err)
	}
	if s.addr != ":9000" || s.dataDir != "/flag/data" || s.secure != server.SecureNever ||
		len(s.proxies) != 1 || s.publicURL != "https://drive.example.com" {
		t.Errorf("settings = %+v", s)
	}
}

func TestParseSettingsRejectsBadValues(t *testing.T) {
	for _, args := range [][]string{
		{"--secure", "maybe"},
		{"--trusted-proxies", "nope"},
		{"--public-url", "nope"},
	} {
		if _, err := parseSettings(args); err == nil {
			t.Errorf("parseSettings(%v) accepted", args)
		}
	}
}
