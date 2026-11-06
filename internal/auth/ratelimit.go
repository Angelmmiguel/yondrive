package auth

import (
	"sync"
	"time"
)

// Default rate limit: attempts per window and per key.
const (
	DefaultLoginAttempts = 10
	DefaultLoginWindow   = time.Minute
)

// purgeThreshold is the number of tracked keys above which Allow sweeps
// expired entries, at most once per window: sweeping on every call would be
// O(n) per request, which a stream of distinct source addresses turns into
// quadratic work.
const purgeThreshold = 1024

// maxBuckets bounds the memory a spray of source addresses can take. Above
// it the limiter forgets every window and starts over, which is the lesser
// evil: refusing new addresses would lock the owner out from a fresh one,
// and an attacker with this many addresses is not slowed by per-address
// counting anyway.
const maxBuckets = 1 << 16

// RateLimiter is a fixed-window counter by key, used to slow down guessing.
type RateLimiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu        sync.Mutex
	buckets   map[string]*bucket
	nextPurge time.Time
}

type bucket struct {
	count int
	reset time.Time
}

// NewRateLimiter returns a limiter allowing limit events per window and key,
// reading the time from now. Non-positive values and a nil now fall back to
// the defaults.
func NewRateLimiter(limit int, window time.Duration, now func() time.Time) *RateLimiter {
	if limit <= 0 {
		limit = DefaultLoginAttempts
	}
	if window <= 0 {
		window = DefaultLoginWindow
	}
	if now == nil {
		now = time.Now
	}
	return &RateLimiter{
		limit:   limit,
		window:  window,
		now:     now,
		buckets: make(map[string]*bucket),
	}
}

// Allow records an attempt for key and reports whether it is within the limit.
func (l *RateLimiter) Allow(key string) bool {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buckets) > purgeThreshold && !now.Before(l.nextPurge) {
		l.purge(now)
		l.nextPurge = now.Add(l.window)
	}
	if len(l.buckets) >= maxBuckets {
		l.buckets = make(map[string]*bucket)
	}

	b, ok := l.buckets[key]
	if !ok || !now.Before(b.reset) {
		l.buckets[key] = &bucket{count: 1, reset: now.Add(l.window)}
		return true
	}
	b.count++
	return b.count <= l.limit
}

// purge drops windows that have elapsed. The caller holds the lock.
func (l *RateLimiter) purge(now time.Time) {
	for key, b := range l.buckets {
		if !now.Before(b.reset) {
			delete(l.buckets, key)
		}
	}
}
