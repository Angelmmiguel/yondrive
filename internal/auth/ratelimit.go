package auth

import (
	"container/list"
	"sync"
	"time"
)

// Default rate limit: attempts per window and per key.
const (
	DefaultLoginAttempts = 10
	DefaultLoginWindow   = time.Minute
)

// maxBuckets bounds the memory a spray of keys can take. Above it the limiter
// forgets the window closest to ending. Forgetting all of them would let a spray
// clear the limits on everyone else, and refusing new keys would lock the owner
// out from a fresh address.
const maxBuckets = 1 << 16

// RateLimiter is a fixed-window counter by key, used to slow down guessing.
type RateLimiter struct {
	limit  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	buckets map[string]*list.Element
	// order holds the open windows, soonest to end first. Every window lasts the
	// same, so that is the order they opened in, and expiry and eviction both
	// take from the front without a scan.
	order *list.List
}

type bucket struct {
	key   string
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
		buckets: make(map[string]*list.Element),
		order:   list.New(),
	}
}

// Allow records an attempt for key and reports whether it is within the limit.
func (l *RateLimiter) Allow(key string) bool {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()
	for front := l.order.Front(); front != nil && !now.Before(front.Value.(*bucket).reset); front = l.order.Front() {
		l.remove(front)
	}
	if e, ok := l.buckets[key]; ok {
		b := e.Value.(*bucket)
		b.count++
		return b.count <= l.limit
	}
	if len(l.buckets) >= maxBuckets {
		l.remove(l.order.Front())
	}
	l.buckets[key] = l.order.PushBack(&bucket{key: key, count: 1, reset: now.Add(l.window)})
	return true
}

// remove forgets a window. The caller holds the lock.
func (l *RateLimiter) remove(e *list.Element) {
	delete(l.buckets, e.Value.(*bucket).key)
	l.order.Remove(e)
}
