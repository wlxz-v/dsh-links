package dlp

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

func (h *Hub) SetVersion(version string) {
	if version == "" {
		version = "dev"
	}
	h.version.Store(&version)
}

func (h *Hub) versionString() string {
	if p := h.version.Load(); p != nil && *p != "" {
		return *p
	}
	return "dev"
}

func (h *Hub) noteHostRegister() {
	h.statHosts.Add(1)
}

func (h *Hub) noteClientOpen() {
	h.statOpen.Add(1)
}

func (h *Hub) noteStream() {
	h.statStreams.Add(1)
}

func (h *Hub) noteBytes(n int64) {
	if n <= 0 {
		return
	}
	h.statBytes.Add(n)
}

func (h *Hub) noteReject(code string) {
	if !safeLogCode(code) {
		code = "OTHER"
	}
	h.statsMu.Lock()
	h.statReject[code]++
	h.statsMu.Unlock()
}

func (h *Hub) statsLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-h.done:
			return
		case <-ticker.C:
			h.maybeFlushStats()
		}
	}
}

func (h *Hub) maybeFlushStats() {
	now := h.cfg.Now()
	h.statsMu.Lock()
	if now.Sub(h.statsAt) < 5*time.Minute {
		h.statsMu.Unlock()
		return
	}
	hosts := h.statHosts.Swap(0)
	streams := h.statStreams.Swap(0)
	open := h.statOpen.Swap(0)
	bytes := h.statBytes.Swap(0)
	reject := h.statReject
	h.statReject = map[string]int64{}
	h.statsAt = now
	h.statsMu.Unlock()
	h.logger.Printf("%s", formatStats(hosts, streams, open, reject, bytes))
}

func formatStats(hosts, streams, open int64, reject map[string]int64, bytes int64) string {
	keys := make([]string, 0, len(reject))
	for code := range reject {
		keys = append(keys, code)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, code := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", code, reject[code]))
	}
	return fmt.Sprintf(
		"stats hosts=%d streams=%d open=%d reject{%s} bytes=%s",
		hosts, streams, open, strings.Join(parts, ","), formatBytes(bytes),
	)
}

func formatBytes(n int64) string {
	const mib = 1024 * 1024
	if n >= mib {
		return fmt.Sprintf("%.1fMiB", float64(n)/float64(mib))
	}
	if n >= 1024 {
		return fmt.Sprintf("%.1fKiB", float64(n)/1024)
	}
	return fmt.Sprintf("%dB", n)
}
