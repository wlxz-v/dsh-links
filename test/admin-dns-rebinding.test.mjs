import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import https from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../src/index.js";
import { isLoopbackHostname, requireLoopbackSameOrigin } from "../src/http-utils.js";

function makeMockRes(req) {
  let status = 0;
  let headers = {};
  let raw = "";
  return {
    req,
    writeHead(c, h) { status = c; headers = h || {}; },
    end(b) { raw = b == null ? "" : Buffer.isBuffer(b) ? b.toString("utf8") : String(b); },
    result() {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      return { status, headers, body, raw };
    },
  };
}

function sendHttp({ port, path, method = "GET", headers = {}, body, tls = false }) {
  return new Promise((resolve, reject) => {
    const mod = tls ? https : { request: httpRequest };
    const req = mod.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: { connection: "close", ...headers },
      ...(tls ? { rejectUnauthorized: false } : {}),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("isLoopbackHostname allows standard loopback hosts and rejects lookalikes", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isLoopbackHostname("evil.com"), false);
  assert.equal(isLoopbackHostname("127.0.0.1.evil.com"), false);
  assert.equal(isLoopbackHostname("127.0.0.1.nip.io"), false);
  assert.equal(isLoopbackHostname("localhost.evil.com"), false);
});

test("requireLoopbackSameOrigin blocks DNS-rebinding, port mismatch, duplicate Host, and cross-site headers", () => {
  const baseReq = (overrides = {}) => ({
    method: "GET",
    headers: { host: "127.0.0.1:3080", ...(overrides.headers || {}) },
    rawHeaders: overrides.rawHeaders,
    socket: { remoteAddress: "127.0.0.1", localPort: 3080, ...(overrides.socket || {}) },
  });

  const cases = [
    { name: "evil Host", req: baseReq({ headers: { host: "evil.com:3080" } }) },
    { name: "suffix lookalike Host", req: baseReq({ headers: { host: "127.0.0.1.evil.com:3080" } }) },
    { name: "nip.io Host", req: baseReq({ headers: { host: "127.0.0.1.nip.io:3080" } }) },
    { name: "userinfo @ in Host", req: baseReq({ headers: { host: "user@127.0.0.1:3080" } }) },
    { name: "whitespace in Host", req: baseReq({ headers: { host: "127.0.0.1 :3080" } }) },
    { name: "wrong port Host", req: baseReq({ headers: { host: "localhost:9999" } }) },
    { name: "implicit port 80 on non-80 socket", req: baseReq({ headers: { host: "localhost" } }) },
    { name: "duplicate Host rawHeaders", req: baseReq({ rawHeaders: ["Host", "127.0.0.1:3080", "Host", "evil.com"] }) },
    { name: "sec-fetch-site cross-site", req: baseReq({ headers: { "sec-fetch-site": "cross-site" } }) },
    { name: "sec-fetch-site same-site", req: baseReq({ headers: { "sec-fetch-site": "same-site" } }) },
    { name: "cross-origin Origin", req: baseReq({ headers: { origin: "http://evil.com:3080" } }) },
    { name: "null Origin", req: baseReq({ headers: { origin: "null" } }) },
    { name: "non-http Origin", req: baseReq({ headers: { origin: "file://127.0.0.1:3080" } }) },
    { name: "non-loopback remote", req: baseReq({ socket: { remoteAddress: "192.168.1.50", localPort: 3080 } }) },
  ];

  for (const c of cases) {
    const res = makeMockRes(c.req);
    const ok = requireLoopbackSameOrigin(c.req, res);
    assert.equal(ok, false, c.name + " should be blocked");
    assert.equal(res.result().status, 403, c.name + " should return 403");
  }

  const validReq = baseReq({ headers: { host: "localhost:3080", origin: "http://localhost:3080", "sec-fetch-site": "same-origin" } });
  const validRes = makeMockRes(validReq);
  assert.equal(requireLoopbackSameOrigin(validReq, validRes), true);
});

test("all 18 admin routes enforce loopback/method/content-type and stay isolated from 18640 proxy port", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "dsh-a1-test-"));
  const routes = new Map();
  const effects = [];
  const upstream = createServer((req, res) => {
    const handler = routes.get(req.url?.split("?")[0] || "");
    if (handler) return void handler(req, res);
    res.writeHead(404); res.end("not found");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const webPort = upstream.address().port;

  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === "webServer") {
        return {
          port: webPort,
          register(r) { routes.set(r.path, r.handler); return () => routes.delete(r.path); },
          tapIndex() { return () => {}; },
        };
      }
      return null;
    },
    on() {},
    effect(fn) { effects.push(fn()); },
  };

  const proxyPort = 22000 + Math.floor(Math.random() * 1000);
  await apply(ctx, {
    port: proxyPort,
    pairingTtlSeconds: 300,
    autoApprove: true,
    stateDir: tmpDir,
    eventPollIntervalMs: 60000,
  });

  try {
    assert.equal(routes.size, 18, "expected 18 registered admin routes");

    const okRes = await sendHttp({ port: webPort, path: "/dsh-link/pair-info" });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.headers["cache-control"], "no-store");
    assert.ok(String(okRes.headers.vary || "").includes("origin"));
    assert.ok(String(okRes.headers.vary || "").includes("sec-fetch-site"));

    const wrongMethod = await sendHttp({
      port: webPort,
      path: "/dsh-link/devices",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(wrongMethod.status, 405);

    const textPost = await sendHttp({
      port: webPort,
      path: "/dsh-link/pair-settings",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{\"requireConfirm\":true}",
    });
    assert.equal(textPost.status, 415);

    const badHost = await sendHttp({
      port: webPort,
      path: "/dsh-link/pair-info",
      headers: { Host: "localhost:9999" },
    });
    assert.equal(badHost.status, 403);

    for (const path of routes.keys()) {
      const res = await sendHttp({ port: proxyPort, path, tls: true });
      assert.equal(res.status, 404, path + " must return 404 on mobile proxy port");
    }
  } finally {
    for (const fn of effects) { try { fn(); } catch {} }
    await new Promise((r) => upstream.close(r));
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
