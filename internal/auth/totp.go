package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 6238 authenticator apps use HMAC-SHA1
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// TOTP parameters: the defaults every authenticator app understands.
const (
	TOTPSecretLen = 20
	TOTPDigits    = 6
	totpPeriod    = 30 // seconds
	totpSkew      = 1  // steps accepted either side of the current one
)

// RecoveryCodeCount is how many recovery codes an enrolment yields.
const RecoveryCodeCount = 10

var totpEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewTOTPSecret returns a random secret.
func NewTOTPSecret() []byte {
	b := make([]byte, TOTPSecretLen)
	_, _ = rand.Read(b)
	return b
}

// EncodeTOTPSecret returns the secret in the base32 form authenticator apps
// take.
func EncodeTOTPSecret(secret []byte) string { return totpEncoding.EncodeToString(secret) }

// TOTPURI returns the otpauth:// address an authenticator app enrols from.
func TOTPURI(issuer, account string, secret []byte) string {
	u := url.URL{
		Scheme: "otpauth",
		Host:   "totp",
		Path:   "/" + issuer + ":" + account,
		RawQuery: url.Values{
			"secret":    {EncodeTOTPSecret(secret)},
			"issuer":    {issuer},
			"algorithm": {"SHA1"},
			"digits":    {fmt.Sprint(TOTPDigits)},
			"period":    {fmt.Sprint(totpPeriod)},
		}.Encode(),
	}
	return u.String()
}

// hotp computes the RFC 4226 one-time password for a counter.
func hotp(secret []byte, counter uint64, digits int) string {
	mac := hmac.New(sha1.New, secret)
	_ = binary.Write(mac, binary.BigEndian, counter)
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	mod := uint32(1)
	for range digits {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, value%mod)
}

// totpStep returns the time step that t falls in.
func totpStep(t time.Time) int64 { return t.Unix() / totpPeriod }

// TOTPCode returns the code for time t. Tests and clients use it; the server
// only ever verifies.
func TOTPCode(secret []byte, t time.Time) string {
	return hotp(secret, uint64(totpStep(t)), TOTPDigits) //nolint:gosec // unix time is positive
}

// VerifyTOTP checks code against the steps around now, and returns the step it
// matched. Steps at or before lastStep are skipped, so a code cannot be used
// twice; the caller still has to record the returned step atomically. Every
// candidate is compared, so timing says nothing about which one matched.
func VerifyTOTP(secret []byte, code string, now time.Time, lastStep int64) (int64, bool) {
	var matched int64
	found := 0
	current := totpStep(now)
	for step := current - totpSkew; step <= current+totpSkew; step++ {
		want := hotp(secret, uint64(step), TOTPDigits) //nolint:gosec // unix time is positive
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 && step > lastStep && found == 0 {
			matched, found = step, 1
		}
	}
	return matched, found == 1
}

// NewRecoveryCodes returns fresh recovery codes in display form: 16 base32
// characters in two groups, 80 random bits each.
func NewRecoveryCodes() []string {
	codes := make([]string, RecoveryCodeCount)
	for i := range codes {
		var b [10]byte
		_, _ = rand.Read(b[:])
		s := totpEncoding.EncodeToString(b[:])
		codes[i] = s[:8] + "-" + s[8:]
	}
	return codes
}

// HashRecoveryCode returns the stored form of a recovery code, ignoring case
// and the separator so that a code typed by hand matches.
func HashRecoveryCode(code string) []byte {
	code = strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(code))
	return HashToken(code)
}
