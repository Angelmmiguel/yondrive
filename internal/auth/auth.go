// Package auth holds the server side of YonDrive's authentication: credential
// hashing, one-time tokens, the fake KDF parameters, session keys, rate limits
// and TOTP.
//
// The server never sees a passphrase or an encryption key. The client derives
// an auth key from the passphrase and a second one from its recovery key; those
// two are the only credentials it ever sends.
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
)

// AuthKeyLen is the required length in bytes of an auth key.
const AuthKeyLen = 32

// Parameters of the Argon2id every new account uses, and of the fake answer
// for unknown usernames, which has to look the same.
const (
	KDFName        = "argon2id"
	KDFMemoryKiB   = 65536
	KDFIterations  = 3
	KDFParallelism = 1
	KDFSaltLen     = 16
)

// HashKey returns the stored form of an auth key.
//
// A slow hash would add nothing. The recovery auth key derives from 256 random
// bits and cannot be guessed. The passphrase auth key carries only the
// passphrase's entropy, but every guess at it already costs the client-side
// Argon2id run; what matters is that the keys are never stored and that
// comparisons are constant time.
func HashKey(key []byte) []byte {
	sum := sha256.Sum256(key)
	return sum[:]
}

// VerifyKey reports whether key matches either stored hash. Both are always
// compared and the results combined, and a missing hash (an unknown user, an
// account without a recovery key) costs the same as a wrong one, so timing
// reveals neither which credential was tried nor whether the account exists.
func VerifyKey(key, hash, recoveryHash []byte) bool {
	if len(key) != AuthKeyLen {
		return false
	}
	sum := sha256.Sum256(key)
	primary := subtle.ConstantTimeCompare(sum[:], paddedHash(hash))
	recovery := subtle.ConstantTimeCompare(sum[:], paddedHash(recoveryHash))
	return (primary | recovery) == 1
}

// paddedHash stands in the all-zero digest, which no key hashes to, for a hash
// that is absent or malformed.
func paddedHash(hash []byte) []byte {
	if len(hash) != sha256.Size {
		return make([]byte, sha256.Size)
	}
	return hash
}

// NewToken returns 32 random bytes, base64url encoded: a session, bearer,
// invite, reset or setup token.
func NewToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// HashToken returns the stored form of a token. A digest is enough because
// tokens are high-entropy, and looking one up by digest tells an attacker who
// can time it nothing about the token.
func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// TokenMatches compares a presented token with a stored hash in constant time.
func TokenMatches(token string, hash []byte) bool {
	return subtle.ConstantTimeCompare(HashToken(token), paddedHash(hash)) == 1
}

// FakeSalt derives the salt shown for a username that does not exist. It is
// stable for a given secret and username, so repeated probes see one answer,
// and cannot be told from a random salt without the secret.
func FakeSalt(secret []byte, username string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("yondrive/fake-kdf-salt/v1\x00"))
	mac.Write([]byte(username))
	return mac.Sum(nil)[:KDFSaltLen]
}
