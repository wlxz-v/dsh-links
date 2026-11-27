import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import https from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../src/index.js";

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
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let jsonBody = null;
        try { jsonBody = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: jsonBody, raw });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function bootPlugin(stateDir) {
  const routes = new Map();
  const effects = [];
  const upstream = createServer((req, res) => {
    const handler = routes.get(req.url?.split("?")[0] || "");
    if (handler) return void handler(req, res);
    if (req.url === "/api/session/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }));
    }
    if (req.url === "/api/workspace/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ result: { ok: true, value: { items: [], archivedSessionIds: [] } } }));
    }
    res.writeHead(404); res.end("not found");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const webPort = upstream.address().port;
  const proxyPort = 23000 + Math.floor(Math.random() * 1000);
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
      if (name === "typertGateway") {
        return {
          async invoke(req) {
            if (req.namespace === "session" && req.method === "list") return { items: [] };
            return {};
          },
          async stream(req) {
            if (req.namespace === "workspace" && req.method === "follow") {
              return (async function* () { yield { type: "baseline", value: { items: [], archivedSessionIds: [] } }; })();
            }
            return (async function* () {})();
          },
        };
      }
      return null;
    },
    on() {},
    effect(fn) { effects.push(fn()); },
  };
  await apply(ctx, { port: proxyPort, pairingTtlSeconds: 300, autoApprove: true, stateDir, eventPollIntervalMs: 60000 });
  return {
    webPort,
    proxyPort,
    async close() {
      for (const fn of effects) { try { fn(); } catch {} }
      await new Promise((r) => upstream.close(r));
    },
  };
}

test("features hot-toggle gates endpoints, updates capabilities, persists across restart, and blocks non-loopback", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "dsh-c3-test-"));
  let env = await bootPlugin(tmpDir);
  try {
    const pairInfo = await sendHttp({ port: env.webPort, path: "/dsh-link/pair-info" });
    const code = pairInfo.body.pairingCode;
    const pairRes = await sendHttp({
      port: env.proxyPort,
      path: "/dsh-link/pair",
      method: "POST",
      tls: true,
      headers: { "content-type": "application/json" },
      body: { name: "Phone", code },
    });
    assert.equal(pairRes.status, 200);
    const token = pairRes.body.token;
    const auth = { "x-dsh-link-token": token };

    // Default: all features enabled
    const f0 = await sendHttp({ port: env.webPort, path: "/dsh-link/features.json" });
    assert.equal(f0.status, 200);
    assert.deepEqual(f0.body.features, { previewProxy: true, workspaceFiles: true, diagnostics: true });
    assert.equal(f0.body.remoteRelay, false);

    const b0 = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/bootstrap", tls: true, headers: auth });
    assert.equal(b0.status, 200);
    assert.ok(b0.body.capabilities.files);
    assert.ok(b0.body.capabilities.preview);
    assert.ok(b0.body.capabilities.diagnostics);

    // Unknown key -> 400
    const badKey = await sendHttp({
      port: env.webPort,
      path: "/dsh-link/features",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { unknownFeature: false },
    });
    assert.equal(badKey.status, 400);

    // Admin feature routes hidden on 18640 proxy port
    const proxyFeatures = await sendHttp({ port: env.proxyPort, path: "/dsh-link/features.json", tls: true, headers: auth });
    assert.equal(proxyFeatures.status, 404);

    // Non-loopback host on panel port -> 403
    const evilFeatures = await sendHttp({ port: env.webPort, path: "/dsh-link/features.json", headers: { Host: "evil.com:" + env.webPort } });
    assert.equal(evilFeatures.status, 403);

    // Disable workspaceFiles, previewProxy, diagnostics live
    const offRes = await sendHttp({
      port: env.webPort,
      path: "/dsh-link/features",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { workspaceFiles: false, previewProxy: false, diagnostics: false },
    });
    assert.equal(offRes.status, 200);
    assert.deepEqual(offRes.body.features, { previewProxy: false, workspaceFiles: false, diagnostics: false });

    const fileOff = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/sessions/s1/file?path=a.txt", tls: true, headers: auth });
    assert.equal(fileOff.status, 403);
    assert.equal(fileOff.body.error, "feature_disabled");
    assert.equal(fileOff.body.feature, "workspaceFiles");

    const prevOff = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/previews", tls: true, headers: auth });
    assert.equal(prevOff.status, 403);
    assert.equal(prevOff.body.feature, "previewProxy");

    const diagOff = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/diagnostics", tls: true, headers: auth });
    assert.equal(diagOff.status, 403);
    assert.equal(diagOff.body.feature, "diagnostics");

    const b1 = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/bootstrap", tls: true, headers: auth });
    assert.equal(b1.body.capabilities.files, undefined);
    assert.equal(b1.body.capabilities.preview, undefined);
    assert.equal(b1.body.capabilities.diagnostics, undefined);

    // Restart plugin with same stateDir -> persisted state preserved
    await env.close();
    const saved = JSON.parse(readFileSync(join(tmpDir, "state.json"), "utf8"));
    assert.deepEqual(saved.features, { previewProxy: false, workspaceFiles: false, diagnostics: false });

    env = await bootPlugin(tmpDir);
    const fReload = await sendHttp({ port: env.webPort, path: "/dsh-link/features.json" });
    assert.deepEqual(fReload.body.features, { previewProxy: false, workspaceFiles: false, diagnostics: false });

    // Re-enable workspaceFiles & diagnostics -> immediate recovery
    const onRes = await sendHttp({
      port: env.webPort,
      path: "/dsh-link/features",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { workspaceFiles: true, diagnostics: true },
    });
    assert.equal(onRes.status, 200);
    const b2 = await sendHttp({ port: env.proxyPort, path: "/dsh-link/mobile/bootstrap", tls: true, headers: auth });
    assert.ok(b2.body.capabilities.files);
    assert.ok(b2.body.capabilities.diagnostics);
    assert.equal(b2.body.capabilities.preview, undefined);
  } finally {
    await env.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
