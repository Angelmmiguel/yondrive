package auth

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestVerifyKey(t *testing.T) {
	key, recovery, other := bytes.Repeat([]byte{1}, AuthKeyLen), bytes.Repeat([]byte{2}, AuthKeyLen), bytes.Repeat([]byte{3}, AuthKeyLen)
	h, r := HashKey(key), HashKey(recovery)
	for _, tc := range []struct {
		name string
		key  []byte
		hash []byte
		rec  []byte
		want bool
	}{
		{"passphrase key", key, h, r, true},
		{"recovery key", recovery, h, r, true},
		{"wrong key", other, h, r, false},
		{"short key", key[:16], h, r, false},
		{"no recovery hash", other, h, nil, false},
		{"no recovery hash, right key", key, h, nil, true},
		{"unknown user", key, nil, nil, false},
		{"zero key against nothing", make([]byte, AuthKeyLen), nil, nil, false},
	} {
		if got := VerifyKey(tc.key, tc.hash, tc.rec); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestTokens(t *testing.T) {
	a, b := NewToken(), NewToken()
	if a == b || len(a) != 43 {
		t.Errorf("tokens %q, %q", a, b)
	}
	if !TokenMatches(a, HashToken(a)) || TokenMatches(b, HashToken(a)) || TokenMatches(a, nil) {
		t.Error("TokenMatches is wrong")
	}
}

func TestFakeSaltIsStableAndKeyed(t *testing.T) {
	s1, s2 := []byte("secret one"), []byte("secret two")
	a := FakeSalt(s1, "alice")
	if len(a) != KDFSaltLen {
		t.Fatalf("salt is %d bytes", len(a))
	}
	if !bytes.Equal(a, FakeSalt(s1, "alice")) {
		t.Error("not stable")
	}
	if bytes.Equal(a, FakeSalt(s1, "bob")) {
		t.Error("the same for two usernames")
	}
	if bytes.Equal(a, FakeSalt(s2, "alice")) {
		t.Error("not keyed by the secret")
	}
}

func TestSessionKeys(t *testing.T) {
	s := NewSessionKeys()
	h1, h2 := []byte("one"), []byte("two")
	if _, ok := s.Get(h1); ok {
		t.Error("key before Set")
	}
	key := bytes.Repeat([]byte{7}, SessionKeyLen)
	s.Set(h1, key)
	s.Set(h2, key)
	key[0] = 0
	got, ok := s.Get(h1)
	if !ok || got[0] != 7 {
		t.Errorf("Set kept the caller's slice: %x", got)
	}
	got[1] = 0
	if again, _ := s.Get(h1); again[1] != 7 {
		t.Error("Get handed out the stored slice")
	}
	stored := s.keys[string(h1)]
	s.Drop(h1)
	if stored[0] != 0 {
		t.Error("Drop did not wipe the key")
	}
	if _, ok := s.Get(h1); ok || s.Len() != 1 {
		t.Errorf("after Drop: %v, %d", ok, s.Len())
	}
}

func TestSessionKeysConcurrent(t *testing.T) {
	s := NewSessionKeys()
	var wg sync.WaitGroup
	for i := range 16 {
		wg.Go(func() {
			h := []byte(fmt.Sprint(i))
			s.Set(h, make([]byte, SessionKeyLen))
			s.Get(h)
			s.Drop(h)
		})
	}
	wg.Wait()
	if s.Len() != 0 {
		t.Errorf("Len = %d", s.Len())
	}
}

func TestRateLimiter(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewRateLimiter(2, time.Minute, func() time.Time { return now })
	for i, want := range []bool{true, true, false, false} {
		if got := l.Allow("a"); got != want {
			t.Errorf("attempt %d = %v", i, got)
		}
	}
	if !l.Allow("b") {
		t.Error("another key was limited")
	}
	now = now.Add(time.Minute)
	if !l.Allow("a") {
		t.Error("window did not reset")
	}
}

func TestRateLimiterDefaultsAndBounds(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewRateLimiter(0, 0, func() time.Time { return now })
	if l.limit != DefaultLoginAttempts || l.window != DefaultLoginWindow {
		t.Errorf("defaults = %d, %v", l.limit, l.window)
	}
	if NewRateLimiter(1, time.Second, nil).now == nil {
		t.Error("no clock")
	}
	for i := range purgeThreshold + 2 {
		l.Allow(fmt.Sprint(i))
	}
	now = now.Add(2 * DefaultLoginWindow)
	l.Allow("x")
	if len(l.buckets) != 1 {
		t.Errorf("expired windows not swept: %d", len(l.buckets))
	}
	for i := range maxBuckets + 1 {
		l.Allow(fmt.Sprint("spray", i))
	}
	if len(l.buckets) > maxBuckets {
		t.Errorf("%d buckets exceed the bound", len(l.buckets))
	}
}

// The vectors of RFC 6238 appendix B, SHA-1, with its 8-digit codes.
func TestRFC6238Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	for unix, want := range map[int64]string{
		59:          "94287082",
		1111111109:  "07081804",
		1111111111:  "14050471",
		1234567890:  "89005924",
		2000000000:  "69279037",
		20000000000: "65353130",
	} {
		if got := hotp(secret, uint64(unix/totpPeriod), 8); got != want { //nolint:gosec // positive constants
			t.Errorf("t=%d: %s, want %s", unix, got, want)
		}
	}
	if got := TOTPCode(secret, time.Unix(59, 0)); got != "287082" {
		t.Errorf("six digits: %s", got)
	}
}

func TestRFC4226Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	for i, want := range []string{"755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"} {
		if got := hotp(secret, uint64(i), 6); got != want {
			t.Errorf("counter %d: %s, want %s", i, got, want)
		}
	}
}

func TestVerifyTOTP(t *testing.T) {
	secret := NewTOTPSecret()
	now := time.Unix(1_800_000_000, 0)
	step := totpStep(now)

	for _, d := range []time.Duration{-30 * time.Second, 0, 30 * time.Second} {
		got, ok := VerifyTOTP(secret, TOTPCode(secret, now.Add(d)), now, 0)
		if !ok || got != step+int64(d/(30*time.Second)) {
			t.Errorf("skew %v: %d, %v", d, got, ok)
		}
	}
	for _, d := range []time.Duration{-time.Minute, time.Minute} {
		if _, ok := VerifyTOTP(secret, TOTPCode(secret, now.Add(d)), now, 0); ok {
			t.Errorf("skew %v accepted", d)
		}
	}
	if _, ok := VerifyTOTP(secret, TOTPCode(secret, now), now, step); ok {
		t.Error("replayed the step already used")
	}
	if _, ok := VerifyTOTP(secret, TOTPCode(secret, now.Add(-30*time.Second)), now, step); ok {
		t.Error("accepted a step before the last one used")
	}
	if _, ok := VerifyTOTP(secret, "", now, 0); ok {
		t.Error("accepted an empty code")
	}
	if _, ok := VerifyTOTP(NewTOTPSecret(), TOTPCode(secret, now), now, 0); ok {
		t.Error("accepted a code under another secret")
	}
}

func TestTOTPURI(t *testing.T) {
	secret, _ := hex.DecodeString("3132333435363738393031323334353637383930")
	u, err := url.Parse(TOTPURI("My Drive", "alice", secret))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Scheme != "otpauth" || u.Host != "totp" || u.Path != "/My Drive:alice" ||
		q.Get("secret") != "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" || q.Get("digits") != "6" || q.Get("issuer") != "My Drive" {
		t.Errorf("uri = %s", u)
	}
}

func TestRecoveryCodes(t *testing.T) {
	codes := NewRecoveryCodes()
	if len(codes) != RecoveryCodeCount {
		t.Fatalf("%d codes", len(codes))
	}
	seen := map[string]bool{}
	for _, c := range codes {
		if seen[c] || len(c) != 17 || c[8] != '-' {
			t.Errorf("code %q", c)
		}
		seen[c] = true
	}
	c := codes[0]
	for _, variant := range []string{strings.ToLower(c), strings.ReplaceAll(c, "-", ""), strings.ReplaceAll(c, "-", " ")} {
		if !bytes.Equal(HashRecoveryCode(variant), HashRecoveryCode(c)) {
			t.Errorf("%q hashes differently", variant)
		}
	}
	if bytes.Equal(HashRecoveryCode(codes[0]), HashRecoveryCode(codes[1])) {
		t.Error("two codes hash the same")
	}
}
