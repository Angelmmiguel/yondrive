package server

import (
	"encoding/json"
	"fmt"
	"net/mail"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	oapi "github.com/Angelmmiguel/yondrive/internal/api"
	"github.com/Angelmmiguel/yondrive/internal/auth"
	"github.com/Angelmmiguel/yondrive/internal/store"
)

// Size limits on what the client seals. The server cannot read these blobs; it
// bounds them so that an account stays small and a mistake shows early.
const (
	publicKeyLen  = 32
	minSealedSize = 32
	maxSealedSize = 512
	maxEmailLen   = 254
	maxNameRunes  = 128
)

// The bounds of the KDF parameters, the same ones clients enforce.
const (
	minKDFMemory = 8192
	maxKDFMemory = 1048576
	maxKDFTime   = 10
)

var (
	usernamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	languagePattern = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)
	// No check against the time zone database: the image has none.
	timeZonePattern = regexp.MustCompile(`^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$`)
)

// normalizeUsername folds the case and surrounding space of a username, so
// that signing in and looking up parameters agree with what is stored.
func normalizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// ParsePublicURL accepts an http or https address with a host and no query,
// fragment or credentials, and returns it without a trailing slash.
func ParsePublicURL(v string) (string, error) {
	v = strings.TrimSpace(v)
	u, err := url.Parse(v)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("%q is not an http or https address", v)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%q must not carry credentials, a query or a fragment", v)
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func validEmail(email string) bool {
	if email == "" || len(email) > maxEmailLen {
		return false
	}
	addr, err := mail.ParseAddress(email)
	return err == nil && addr.Address == email
}

func validName(name string) bool {
	n := utf8.RuneCountInString(name)
	if n == 0 || n > maxNameRunes || strings.TrimSpace(name) == "" {
		return false
	}
	return !strings.ContainsFunc(name, unicode.IsControl)
}

// platformOf checks an optional device platform and returns the form that is
// stored, empty if none was given.
func platformOf(p *oapi.DevicePlatform) (string, error) {
	if p == nil {
		return "", nil
	}
	if !p.Valid() {
		return "", badRequest(codeInvalidPlatform)
	}
	return string(*p), nil
}

// encodeKDF validates KDF parameters and returns the form that is stored.
func encodeKDF(kdf oapi.KDF) ([]byte, error) {
	if kdf.Name != oapi.Argon2id || kdf.M < minKDFMemory || kdf.M > maxKDFMemory ||
		kdf.T < 1 || kdf.T > maxKDFTime || kdf.P != auth.KDFParallelism || len(kdf.Salt) != auth.KDFSaltLen {
		return nil, badRequest(codeInvalidKDF)
	}
	return json.Marshal(kdf)
}

func validSealed(b []byte) bool { return len(b) >= minSealedSize && len(b) <= maxSealedSize }

func validAccountKeys(keys oapi.AccountKeys) bool {
	return validSealed(keys.WrappedMasterKey) && validSealed(keys.WrappedMasterKeyRecovery) &&
		validSealed(keys.SealedX25519) && validSealed(keys.SealedEd25519) &&
		len(keys.PublicKeys.X25519) == publicKeyLen && len(keys.PublicKeys.Ed25519) == publicKeyLen
}

// newUser checks an account against the mode and the size limits and returns
// the record to store. The caller fills in the role and quota.
func newUser(account oapi.NewAccount, mode oapi.Mode, now time.Time) (store.User, error) {
	username := normalizeUsername(account.Username)
	if !usernamePattern.MatchString(username) {
		return store.User{}, badRequest(codeInvalidUsername)
	}
	var email string
	if account.Email != nil {
		email = strings.TrimSpace(*account.Email)
		if !validEmail(email) {
			return store.User{}, badRequest(codeInvalidEmail)
		}
	}
	if len(account.AuthKey) != auth.AuthKeyLen {
		return store.User{}, badRequest(codeInvalidAuthKey)
	}
	kdf, err := encodeKDF(account.Kdf)
	if err != nil {
		return store.User{}, err
	}
	u := store.User{
		ID:        store.NewID(),
		Username:  username,
		Email:     email,
		CreatedAt: now,
		Credentials: store.Credentials{
			AuthKeyHash: auth.HashKey(account.AuthKey),
			KDF:         kdf,
		},
	}
	if mode == oapi.ModeNone {
		if account.RecoveryAuthKey != nil || account.Keys != nil {
			return store.User{}, badRequest(codeKeysNotAllowed)
		}
		return u, nil
	}
	if account.RecoveryAuthKey == nil || account.Keys == nil {
		return store.User{}, badRequest(codeKeysRequired)
	}
	if len(*account.RecoveryAuthKey) != auth.AuthKeyLen {
		return store.User{}, badRequest(codeInvalidAuthKey)
	}
	keys := account.Keys
	if !validAccountKeys(*keys) {
		return store.User{}, badRequest(codeInvalidKeys)
	}
	u.RecoveryAuthKeyHash = auth.HashKey(*account.RecoveryAuthKey)
	u.WrappedMasterKey = keys.WrappedMasterKey
	u.WrappedMasterKeyRecovery = keys.WrappedMasterKeyRecovery
	u.SealedX25519 = keys.SealedX25519
	u.SealedEd25519 = keys.SealedEd25519
	u.PublicKeyX25519 = keys.PublicKeys.X25519
	u.PublicKeyEd25519 = keys.PublicKeys.Ed25519
	return u, nil
}
