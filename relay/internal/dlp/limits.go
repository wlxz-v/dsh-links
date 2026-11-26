package dlp

import (
	"sync"
	"time"
)

const maxLimiterWindows = 65536

type limiter struct {
	mu          sync.Mutex
	windows     map[string]window
	lastCleanup time.Time
	maxEntries  int
}
type window struct {
	tokens  float64
	updated time.Time
}

func newLimiter() *limiter {
	return &limiter{windows: make(map[string]window), maxEntries: maxLimiterWindows}
}

func (l *limiter) allow(key string, limit int, period time.Duration, burst int, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.lastCleanup.IsZero() || now.Sub(l.lastCleanup) >= time.Minute {
		for candidate, value := range l.windows {
			if now.Sub(value.updated) >= 10*time.Minute {
				delete(l.windows, candidate)
			}
		}
		l.lastCleanup = now
	}
	w, exists := l.windows[key]
	if !exists && l.maxEntries > 0 && len(l.windows) >= l.maxEntries {
		for candidate, value := range l.windows {
			if now.Sub(value.updated) >= 10*time.Minute {
				delete(l.windows, candidate)
			}
		}
		if len(l.windows) >= l.maxEntries && period > 0 {
			for candidate, value := range l.windows {
				if now.Sub(value.updated) >= period {
					delete(l.windows, candidate)
				}
			}
		}
		if len(l.windows) >= l.maxEntries {
			return false
		}
	}
	if burst < 1 {
		burst = 1
	}
	if !exists || w.updated.IsZero() {
		w = window{tokens: float64(burst), updated: now}
	} else if now.After(w.updated) {
		w.tokens += now.Sub(w.updated).Seconds() * float64(limit) / period.Seconds()
		if w.tokens > float64(burst) {
			w.tokens = float64(burst)
		}
		w.updated = now
	}
	if w.tokens < 1 {
		l.windows[key] = w
		return false
	}
	w.tokens--
	l.windows[key] = w
	return true
}
