package dlp

import (
	"context"
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestDuplicateHostAcceptDoesNotLeakHostSlot(t *testing.T) {
	cfg := DefaultConfig()
	cfg.IdleTimeout = time.Minute
	cfg.MaxLifetime = time.Hour
	hub, server := testServerWithLogger(t, cfg, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	seed := make([]byte, 32)
	private := ed25519.NewKeyFromSeed(seed)
	pub := private.Public().(ed25519.PublicKey)
	ctrl, route := register(t, ctx, server, seed)
	defer ctrl.Close(websocket.StatusNormalClosure, "")

	client, _ := clientOpen(t, ctx, server, route)
	open := readJSON(t, ctx, ctrl)
	sidText, _ := stringField(open, "sid")
	sid, _ := decodeB64(sidText, 16)

	acceptOnce := func() *websocket.Conn {
		data, challenge := dialWithHello(t, ctx, server)
		transcript, _ := AcceptTranscript(challenge, pub, sid)
		frame := message("host_accept", map[string]any{
			"v": 1, "pub": encodeB64(pub), "sid": sidText,
			"sig": encodeB64(ed25519.Sign(private, transcript)),
		})
		if err := data.Write(ctx, websocket.MessageText, frame); err != nil {
			t.Fatal(err)
		}
		return data
	}

	first := acceptOnce()
	if got, _ := stringField(readJSON(t, ctx, first), "t"); got != "ready" {
		t.Fatalf("first host_accept got %q, want ready", got)
	}
	if got, _ := stringField(readJSON(t, ctx, client), "t"); got != "ready" {
		t.Fatalf("client got %q, want ready", got)
	}

	duplicate := acceptOnce()
	if code, _ := stringField(readJSON(t, ctx, duplicate), "code"); code != "PROTOCOL_ERROR" {
		t.Fatalf("duplicate host_accept error=%q, want PROTOCOL_ERROR", code)
	}
	if status := websocket.CloseStatus(readErr(ctx, duplicate)); status != 4000 {
		t.Fatalf("duplicate host_accept close=%d, want 4000", status)
	}

	_ = client.Close(websocket.StatusNormalClosure, "")
	_ = first.Close(websocket.StatusNormalClosure, "")

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		hub.mu.Lock()
		hostConns := hub.hosts["127.0.0.1"]
		hub.mu.Unlock()
		if hostConns == 1 {
			return
		}
		time.Sleep(15 * time.Millisecond)
	}
	hub.mu.Lock()
	got := hub.hosts["127.0.0.1"]
	hub.mu.Unlock()
	t.Fatalf("host slot leaked after duplicate host_accept: hosts[127.0.0.1]=%d, want 1", got)
}

func TestCrossRouteRejectIsIgnored(t *testing.T) {
	cfg := DefaultConfig()
	server := testServer(t, cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	seedA := make([]byte, 32)
	seedB := make([]byte, 32)
	seedB[0] = 9
	ctrlA, routeA := register(t, ctx, server, seedA)
	defer ctrlA.Close(websocket.StatusNormalClosure, "")
	ctrlB, _ := register(t, ctx, server, seedB)
	defer ctrlB.Close(websocket.StatusNormalClosure, "")

	client, _ := clientOpen(t, ctx, server, routeA)
	defer client.Close(websocket.StatusNormalClosure, "")
	open := readJSON(t, ctx, ctrlA)
	sidText, _ := stringField(open, "sid")
	sid, _ := decodeB64(sidText, 16)

	// Route B tries to reject route A's pending stream; relay must ignore it.
	if err := ctrlB.Write(ctx, websocket.MessageText, message("reject", map[string]any{"sid": sidText, "code": "UNKNOWN_KEY"})); err != nil {
		t.Fatal(err)
	}
	// Ping on ctrlB to guarantee ctrlB's reject frame was processed first.
	if err := ctrlB.Write(ctx, websocket.MessageText, message("ping", map[string]any{})); err != nil {
		t.Fatal(err)
	}
	if got, _ := stringField(readJSON(t, ctx, ctrlB), "t"); got != "pong" {
		t.Fatalf("ctrlB ping got %q", got)
	}

	// Route A can still accept the pending stream normally.
	privateA := ed25519.NewKeyFromSeed(seedA)
	pubA := privateA.Public().(ed25519.PublicKey)
	data, challenge := dialWithHello(t, ctx, server)
	defer data.Close(websocket.StatusNormalClosure, "")
	transcript, _ := AcceptTranscript(challenge, pubA, sid)
	if err := data.Write(ctx, websocket.MessageText, message("host_accept", map[string]any{
		"v": 1, "pub": encodeB64(pubA), "sid": sidText,
		"sig": encodeB64(ed25519.Sign(privateA, transcript)),
	})); err != nil {
		t.Fatal(err)
	}
	if got, _ := stringField(readJSON(t, ctx, data), "t"); got != "ready" {
		t.Fatalf("host data got %q, want ready", got)
	}
	if got, _ := stringField(readJSON(t, ctx, client), "t"); got != "ready" {
		t.Fatalf("client got %q, want ready", got)
	}
}

func TestControlLoopClosesOnInvalidRejectAndUnknownType(t *testing.T) {
	for _, tc := range []struct {
		name  string
		frame []byte
	}{
		{name: "invalid reject", frame: message("reject", map[string]any{"sid": "bad", "code": "UNKNOWN_KEY"})},
		{name: "unknown type", frame: message("bogus", map[string]any{})},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := testServer(t, DefaultConfig())
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			ctrl, _ := register(t, ctx, server, make([]byte, 32))
			defer ctrl.CloseNow()
			if err := ctrl.Write(ctx, websocket.MessageText, tc.frame); err != nil {
				t.Fatal(err)
			}
			if code, _ := stringField(readJSON(t, ctx, ctrl), "code"); code != "PROTOCOL_ERROR" {
				t.Fatalf("got error=%q, want PROTOCOL_ERROR", code)
			}
			if status := websocket.CloseStatus(readErr(ctx, ctrl)); status != 4000 {
				t.Fatalf("close=%d, want 4000", status)
			}
		})
	}
}

func TestClientIPMultipleXFFHeadersAndIPv4Mapped(t *testing.T) {
	h := NewHub(DefaultConfig(), nil)
	defer h.Close()

	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.RemoteAddr = "[::ffff:127.0.0.1]:54321"
	req.Header.Add("X-Forwarded-For", "198.51.100.10")
	req.Header.Add("X-Forwarded-For", "::ffff:203.0.113.5, 127.0.0.1")
	if got := h.clientIP(req); got != "203.0.113.5" {
		t.Fatalf("clientIP=%q, want 203.0.113.5", got)
	}

	untrusted := httptest.NewRequest(http.MethodGet, "/ws", nil)
	untrusted.RemoteAddr = "[::ffff:198.51.100.7]:40000"
	untrusted.Header.Add("X-Forwarded-For", "203.0.113.99")
	if got := h.clientIP(untrusted); got != "198.51.100.7" {
		t.Fatalf("untrusted clientIP=%q, want 198.51.100.7", got)
	}
}

func TestLimiterCapsActiveWindowsAndSweepsExpired(t *testing.T) {
	lim := newLimiter()
	lim.maxEntries = 3
	now := time.Unix(1000, 0)

	for _, ip := range []string{"192.0.2.1", "192.0.2.2", "192.0.2.3"} {
		if !lim.allow(ip, 60, time.Minute, 5, now) {
			t.Fatalf("initial allow failed for %s", ip)
		}
	}
	// Map is full with fresh entries (< period): new IP must fail closed without evicting active windows.
	if lim.allow("192.0.2.4", 60, time.Minute, 5, now.Add(10*time.Second)) {
		t.Fatal("new key was allowed when active window cap was full")
	}
	if len(lim.windows) != 3 {
		t.Fatalf("windows len=%d, want 3", len(lim.windows))
	}
	// Existing key still works within its own bucket.
	if !lim.allow("192.0.2.1", 60, time.Minute, 5, now.Add(10*time.Second)) {
		t.Fatal("existing key was unexpectedly rejected")
	}
	// After period elapses, fully refilled entries are reclaimed and the new IP succeeds.
	if !lim.allow("192.0.2.4", 60, time.Minute, 5, now.Add(time.Minute)) {
		t.Fatal("new key was rejected after expired windows could be swept")
	}
}

func TestIntFieldRejectsStringsAndNonCanonicalNumbers(t *testing.T) {
	for _, raw := range []string{
		`{"v":"1"}`,
		`{"v":1.0}`,
		`{"v":1e2}`,
		`{"v":-0}`,
		`{"v":9007199254740992}`,
		`{"v":-9007199254740992}`,
	} {
		frame, err := ParseControl([]byte(raw))
		if err != nil {
			t.Fatalf("ParseControl(%s) failed: %v", raw, err)
		}
		if _, err := intField(frame, "v"); err == nil {
			t.Fatalf("intField accepted non-canonical value: %s", raw)
		}
	}
	for _, tc := range []struct {
		raw  string
		want int64
	}{
		{`{"v":0}`, 0},
		{`{"v":1}`, 1},
		{`{"v":9007199254740991}`, (1 << 53) - 1},
		{`{"v":-9007199254740991}`, -((1 << 53) - 1)},
	} {
		frame, err := ParseControl([]byte(tc.raw))
		if err != nil {
			t.Fatalf("ParseControl(%s) failed: %v", tc.raw, err)
		}
		got, err := intField(frame, "v")
		if err != nil || got != tc.want {
			t.Fatalf("intField(%s) = (%d, %v), want (%d, nil)", tc.raw, got, err, tc.want)
		}
	}
}

func TestHubStringReportsActiveAndPendingStreams(t *testing.T) {
	h := NewHub(DefaultConfig(), nil)
	defer h.Close()
	var id [16]byte
	id[0] = 7
	h.mu.Lock()
	h.routes[id] = &route{active: 2, pending: 1}
	h.mu.Unlock()
	if got := h.String(); !strings.Contains(got, "routes=1 streams=3") {
		t.Fatalf("Hub.String() = %q, want routes=1 streams=3", got)
	}
}
