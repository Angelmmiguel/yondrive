package auth

import (
	"bytes"
	"sync"
	"time"
)

// Session lifetimes unless configured otherwise: an idle window that use
// extends, and a deadline nothing extends, so that a stolen cookie used every
// day still dies.
const (
	DefaultSessionTTL    = 24 * time.Hour
	DefaultSessionMaxAge = 7 * 24 * time.Hour
)

// SessionKeyLen is the required length in bytes of a session key.
const SessionKeyLen = 32

// SessionKeys holds the server half of each client's split session key, which
// lets a browser survive a page refresh without the passphrase. Sessions are
// in the database; these keys never are. They are gone after a restart, when
// the client asks for the passphrase again.
type SessionKeys struct {
	mu   sync.Mutex
	keys map[string][]byte // session hash -> key
}

// NewSessionKeys returns an empty set.
func NewSessionKeys() *SessionKeys {
	return &SessionKeys{keys: make(map[string][]byte)}
}

// Set stores a copy of key for a session, wiping any previous one.
func (s *SessionKeys) Set(sessionHash, key []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.keys[string(sessionHash)])
	s.keys[string(sessionHash)] = bytes.Clone(key)
}

// Get returns a copy of a session's key, or false if it has none.
func (s *SessionKeys) Get(sessionHash []byte) ([]byte, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key, ok := s.keys[string(sessionHash)]
	return bytes.Clone(key), ok
}

// Drop wipes and forgets the keys of the given sessions.
//
// Wiping is best effort: Go may already have copied the bytes, and the copies
// handed out by Get are the caller's. It still shortens how long a key sits in
// freed memory.
func (s *SessionKeys) Drop(sessionHashes ...[]byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, h := range sessionHashes {
		clear(s.keys[string(h)])
		delete(s.keys, string(h))
	}
}

// Len returns how many keys are held.
func (s *SessionKeys) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.keys)
}
